import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createRelayServer } from "./server.mjs";

const origin = "https://temco.test";
const printer = { id: "p1", name: "Shipping", endpoint: "http://printer.test:9100", contentType: "text/plain" };

async function fixture(t, options = {}) {
  const state = { active: true, printers: [printer] };
  const relay = createRelayServer({
    origin, heartbeatInterval: 60000,
    authenticate: async (cookie) => state.active && cookie.startsWith("session=") ? { userId: cookie, printers: state.printers } : null,
    ...options,
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.server.address().port}/api/label-relay/ws`;
  async function connect(user = "scanner") {
    const ws = new WebSocket(url, { origin, headers: { cookie: `session=${user}` } });
    const messages = [];
    const waiters = [];
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "heartbeat") ws.send(JSON.stringify({ type: "heartbeat" }));
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else messages.push(message);
    });
    const next = (type, predicate = () => true) => new Promise((resolve, reject) => {
      const matches = (message) => message.type === type && predicate(message);
      const index = messages.findIndex(matches);
      if (index >= 0) { resolve(messages.splice(index, 1)[0]); return; }
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
      waiters.push({ predicate: matches, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
    const send = (message) => ws.send(JSON.stringify(message));
    await next("hello");
    return { ws, send, next, messages };
  }
  async function laptop(name = "Warehouse laptop", printerIds = ["p1"]) {
    const client = await connect(name);
    client.send({ type: "register", name, printerIds });
    await client.next("registered");
    return client;
  }
  return { url, state, connect, laptop };
}

const print = (client, requestId = "r1", extra = {}) => client.send({ type: "print", requestId, printerId: "p1", zpl: "^XA^FDTest^FS^XZ\x04", ...extra });

test("rejects unsigned and cross-origin WebSocket upgrades", async (t) => {
  const { url } = await fixture(t);
  for (const [headers, expected] of [[{ origin }, 401], [{ origin: "https://evil.test", cookie: "session=user" }, 403], [{ cookie: "session=user" }, 403]]) {
    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); ws.terminate(); });
      ws.on("open", () => reject(new Error("Unexpected successful connection")));
      ws.on("error", () => {});
    });
    assert.equal(status, expected);
  }
});

test("routes across users to exactly one laptop and waits for its acknowledgement", async (t) => {
  const { connect, laptop } = await fixture(t);
  const first = await laptop("First");
  const second = await laptop("Second");
  const scanner = await connect("another-user");
  print(scanner, "r1", { endpoint: "http://unapproved.test" });
  const job = await first.next("job");
  assert.deepEqual(job.printer, printer);
  assert.equal(job.zpl, "^XA^FDTest^FS^XZ\x04");
  assert.equal(scanner.messages.some((item) => item.type === "result"), false);
  second.send({ type: "result", jobId: job.jobId, ok: true });
  first.send({ type: "result", jobId: job.jobId, ok: true });
  const result = await scanner.next("result");
  assert.equal(result.ok, true);
  assert.equal(result.relayName, "First");
  assert.equal(second.messages.some((item) => item.type === "job"), false);
  print(scanner);
  assert.match((await scanner.next("result")).error, /already submitted/);
});

test("missing or inactive printer and offline relay return actionable errors", async (t) => {
  const { connect, state } = await fixture(t);
  const scanner = await connect();
  print(scanner);
  assert.match((await scanner.next("result")).error, /No label relay is online/);
  state.printers = [];
  print(scanner, "r2");
  assert.match((await scanner.next("result")).error, /no longer active/);
});

test("serializes simultaneous scanner jobs on a laptop without dropping labels", async (t) => {
  const { connect, laptop } = await fixture(t);
  const receiver = await laptop();
  const scanner1 = await connect("one");
  const scanner2 = await connect("two");
  print(scanner1, "r1");
  const first = await receiver.next("job");
  print(scanner2, "r2");
  receiver.send({ type: "result", jobId: first.jobId, ok: true });
  const second = await receiver.next("job");
  assert.notEqual(first.jobId, second.jobId);
  receiver.send({ type: "result", jobId: second.jobId, ok: true });
  assert.equal((await scanner1.next("result")).ok, true);
  assert.equal((await scanner2.next("result")).ok, true);
});

test("propagates printer failures and accepts a later job", async (t) => {
  const { connect, laptop } = await fixture(t);
  const receiver = await laptop();
  const scanner = await connect();
  print(scanner);
  const job = await receiver.next("job");
  receiver.send({ type: "result", jobId: job.jobId, ok: false, error: "Printer unreachable" });
  assert.equal((await scanner.next("result")).error, "Printer unreachable");
  print(scanner, "r2");
  const next = await receiver.next("job");
  receiver.send({ type: "result", jobId: next.jobId, ok: true });
  assert.equal((await scanner.next("result")).ok, true);
});

test("disconnect and acknowledgement timeout never reassign an uncertain print", async (t) => {
  for (const disconnect of [true, false]) {
    const { connect, laptop } = await fixture(t, { jobTimeout: 50 });
    const first = await laptop("First");
    const spare = await laptop("Spare");
    const scanner = await connect();
    print(scanner);
    await first.next("job");
    if (disconnect) first.ws.close();
    const result = await scanner.next("result");
    assert.equal(result.ok, false);
    assert.match(result.error, /may have been sent/);
    assert.equal(spare.messages.some((item) => item.type === "job"), false);
  }
});

test("rechecks account status before dispatch", async (t) => {
  const { connect, laptop, state } = await fixture(t);
  const receiver = await laptop();
  const scanner = await connect();
  state.active = false;
  const closed = once(scanner.ws, "close");
  print(scanner);
  assert.equal((await closed)[0], 1008);
  assert.equal(receiver.messages.some((item) => item.type === "job"), false);
});

test("oversized label bodies are rejected", async (t) => {
  const { connect, laptop } = await fixture(t);
  const receiver = await laptop();
  const scanner = await connect();
  const closed = once(scanner.ws, "close");
  print(scanner, "r1", { zpl: "x".repeat(129 * 1024) });
  assert.equal((await closed)[0], 1008);
  assert.equal(receiver.messages.some((item) => item.type === "job"), false);
});

test("queued jobs expire without being printed later", async (t) => {
  const { connect, laptop } = await fixture(t, { queueTimeout: 30 });
  const receiver = await laptop();
  const first = await connect("first");
  const second = await connect("second");
  print(first, "first");
  const job = await receiver.next("job");
  print(second, "second");
  assert.match((await second.next("result")).error, /before sending/);
  receiver.send({ type: "result", jobId: job.jobId, ok: true });
  await first.next("result");
  print(first, "third", { zpl: "third label" });
  assert.equal((await receiver.next("job")).zpl, "third label");
});

test("a disconnected sender's queued label is cancelled", async (t) => {
  const { connect, laptop } = await fixture(t);
  const receiver = await laptop();
  const first = await connect("first");
  const second = await connect("second");
  print(first, "first");
  const job = await receiver.next("job");
  print(second, "second");
  const closed = once(second.ws, "close");
  second.ws.close();
  await closed;
  receiver.send({ type: "result", jobId: job.jobId, ok: true });
  await first.next("result");
  print(first, "third", { zpl: "third label" });
  assert.equal((await receiver.next("job")).zpl, "third label");
});
