import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import bcrypt from "bcryptjs";
import { sealData } from "iron-session";
import { prisma } from "../lib/db";

test("HTTP APIs enforce current sessions, exact origin and private user grants", { skip: !process.env.DATABASE_URL, timeout: 45_000 }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_test", "Dedicated local database required.");
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, secret = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, NODE_ENV: "production", SESSION_SECRET: secret, NEXT_PUBLIC_APP_URL: origin }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
  const username = `http-fixture-${randomUUID()}`;
  const user = await prisma.user.create({ data: { username, displayName: "Synthetic HTTP operator", role: "admin", pinHash: await bcrypt.hash("135790", 12) } });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Test app exited before readiness: ${output}`);
      try { if ((await fetch(`${origin}/signin`)).status === 200) { ready = true; break; } } catch { /* own child still starting */ }
      await delay(100);
    }
    assert.ok(ready, "Test app did not become ready.");
    assert.equal((await fetch(`${origin}/api/warehouse/lookup?value=synthetic`)).status, 401);
    const body = JSON.stringify({ username, pin: "135790" });
    assert.equal((await fetch(`${origin}/api/auth/login`, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status, 403);
    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", body, headers: { Origin: origin, "Content-Type": "application/json" } });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie()[0]?.split(";")[0]; assert.ok(cookie);
    const authorized = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
    assert.equal((await fetch(`${origin}/api/warehouse/lookup?value=synthetic`, { headers: authorized })).status, 200);
    assert.equal((await fetch(`${origin}/api/access-grants`, { method: "POST", body: JSON.stringify({ clientName: "Synthetic HTTP client", scopes: ["inventory.read"] }), headers: { ...authorized, Origin: "https://wrong.example" } })).status, 403);
    const created = await fetch(`${origin}/api/access-grants`, { method: "POST", body: JSON.stringify({ clientName: "Synthetic HTTP client", scopes: ["inventory.read"] }), headers: authorized });
    assert.equal(created.status, 201);
    const legacy = await sealData({ userId: user.id, role: "admin", isActive: true }, { password: secret });
    assert.equal((await fetch(`${origin}/api/warehouse/lookup?value=synthetic`, { headers: { Cookie: `temco_session=${legacy}` } })).status, 401);
    const changed = await fetch(`${origin}/api/admin/users/${user.id}`, { method: "PATCH", headers: authorized, body: JSON.stringify({ role: "user" }) });
    assert.equal(changed.status, 200);
    assert.equal((await fetch(`${origin}/api/access-grants`, { headers: authorized })).status, 401);
    assert.equal((await fetch(`${origin}/api/label-relay/session`, { headers: authorized })).status, 401);
    assert.equal((await fetch(`${origin}/api/api-relay/status`, { method: "POST", headers: authorized, body: "{}" })).status, 401);
    assert.equal((await fetch(`${origin}/api/warehouse/lookup?value=synthetic`, { headers: authorized })).status, 401);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped;
    }
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
