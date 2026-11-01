import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { prisma } from "../lib/db";
import { hashPassword } from "../lib/auth/passwords";

test("phone viewport retains queued observations across reload and user switching", { skip: !process.env.DATABASE_URL, timeout: 60_000 }, async () => {
  const db = new URL(process.env.DATABASE_URL!);
  assert.ok(db.hostname === "127.0.0.1" && db.port === "55439" && db.pathname === "/temcotools_v2_test", "Dedicated local synthetic database required.");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, suffix = randomUUID(), value = `MOBILE-SYNTHETIC-${suffix.toUpperCase()}`;
  const password = "Synthetic mobile operator phrase 7", passwordHash = await hashPassword(password);
  const users = await Promise.all(["a", "b"].map(letter => prisma.user.create({ data: { username: `mobile-${suffix}-${letter}`, displayName: `Synthetic operator ${letter}`, pinHash: "not-usable", passwordHash, roleBundles: { create: { bundleId: "legacy-user" } } } })));
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, NODE_ENV: "production", SESSION_SECRET: randomBytes(32).toString("hex"), MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), NEXT_PUBLIC_APP_URL: origin }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-4000); }); child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-4000); });
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  async function signIn(user: typeof users[number]) {
    await page.goto(`${origin}/signin`);
    await page.getByLabel("Username", { exact: true }).fill(user.username);
    await page.getByLabel("Password or passphrase", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(origin + "/");
  }
  async function signOut() { assert.equal((await context.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin } })).status(), 200); }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Synthetic app exited before readiness: ${logs}`);
      try { if ((await fetch(`${origin}/signin`)).status === 200) { ready = true; break; } } catch { /* own child starting */ }
      await delay(100);
    }
    assert.ok(ready);
    await signIn(users[0]);
    await context.route("**/api/scan-ingestion", route => route.abort("internetdisconnected"));
    await page.goto(`${origin}/tools/warehouse-scan`);
    await page.getByRole("button", { name: "Enter Scanning Mode", exact: true }).click();
    await page.keyboard.type(value); await page.keyboard.press("Enter");
    await page.getByText("Captured on device", { exact: true }).waitFor();
    await page.reload();
    await page.getByText(/pending on device: 1/).waitFor();
    assert.equal(await prisma.warehousePhysicalObservation.count({ where: { rawIdentifier: value } }), 0);
    await signOut(); await signIn(users[1]); await page.goto(`${origin}/tools/warehouse-scan`);
    await page.getByText(/pending on device: 0/).waitFor();
    assert.equal(await prisma.warehousePhysicalObservation.count({ where: { rawIdentifier: value } }), 0);
    await signOut(); await signIn(users[0]); await page.goto(`${origin}/tools/warehouse-scan`);
    await page.getByText(/pending on device: 1/).waitFor();
    await context.unroute("**/api/scan-ingestion");
    await page.getByRole("button", { name: "Save pending observations", exact: true }).click();
    await page.getByText(/pending on device: 0/).waitFor();
    const rows = await prisma.warehousePhysicalObservation.findMany({ where: { rawIdentifier: value } });
    assert.equal(rows.length, 1); assert.equal(rows[0].userId, users[0].id); assert.equal(rows[0].resolution, "unresolved");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally {
    await browser.close();
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    await prisma.warehousePhysicalObservation.deleteMany({ where: { userId: { in: users.map(user => user.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.$disconnect();
  }
});
