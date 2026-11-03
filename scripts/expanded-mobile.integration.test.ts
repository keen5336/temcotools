import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { chromium, expect } from "@playwright/test";
import { hashPassword } from "../lib/auth/passwords";
import { resolve } from "node:path";
const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("integrated mobile warehouse context, platform-only scanner, local workers and Receiving UI", { skip: !url, timeout: 180_000 }, async t => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID();
  const sites = await Promise.all(["A", "B"].map(n => owner.warehouseSite.create({ data: { slug: `mobile-${ns}-${n.toLowerCase()}`, name: `Synthetic mobile ${n}` } })));
  const password = "Synthetic expanded browser phrase 2026", passwordHash = await hashPassword(password);
  const users = await Promise.all([true, false].map((platform, i) => owner.user.create({ data: { username: `mobile-${ns}-${i}`, displayName: platform ? "Synthetic platform admin" : "Synthetic site manager", pinHash: "disabled:v2", passwordHash, passwordChangedAt: new Date(), isPlatformAdmin: platform, role: "admin" } })));
  for (const user of users) for (const site of sites) await owner.warehouseMembership.create({ data: { userId: user.id, siteId: site.id, roles: { create: { roleId: "warehouse-manager" } } } });
  const reserve = createServer(); reserve.listen(0,"127.0.0.1"); await once(reserve,"listening"); const address = reserve.address(); assert.ok(address && typeof address !== "string"); const port = address.port; await new Promise<void>(r => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`, secret = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env: { ...process.env, DATABASE_URL: url!, NODE_ENV: "production", SESSION_SECRET: secret, TEMCO_PILOT_MODE: "read_only_dmp", TEMCO_SESSION_COOKIE_NAME: "temco_expanded_synthetic", NEXT_PUBLIC_APP_URL: origin, API_RELAY_INTERNAL_URL: "http://127.0.0.1:1" }, stdio: ["ignore","pipe","pipe"] });
  let output = ""; child.stdout.on("data", b => { output = (output + b).slice(-3000); }); child.stderr.on("data", b => { output = (output + b).slice(-3000); });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
  const external: string[] = []; await context.route("**/*", route => { const u = new URL(route.request().url()); if ([origin,"null"].includes(u.origin) || ["data:","blob:"].includes(u.protocol)) return route.continue(); external.push(u.origin); return route.abort(); });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  async function signIn(index: number) {
    await context.clearCookies();
    const r = await context.request.post(`${origin}/api/auth/login`, { headers: { Origin: origin }, data: { username: users[index].username, password } }); assert.equal(r.status(), 200, await r.text());
    const session = await owner.userSession.findFirstOrThrow({ where: { userId: users[index].id }, orderBy: { createdAt: "desc" } });
    await owner.userSession.update({ where: { id: session.id }, data: { activeSiteId: sites[0].id } });
  }
  try {
    let ready = false; for (let i=0;i<100;i++) { if (child.exitCode !== null) throw new Error(output); try { if ((await fetch(`${origin}/signin`)).status===200) {ready=true;break;} } catch {} await delay(100); } assert.ok(ready);
    await t.test("anonymous and legacy/site admin are denied the experimental route", async () => {
      await page.goto(`${origin}/tools/scan-lab`); assert.equal(new URL(page.url()).pathname, "/signin");
      await signIn(1); await page.goto(`${origin}/tools/scan-lab`); assert.notEqual(new URL(page.url()).pathname, "/tools/scan-lab");
      await expect(page.getByRole("link",{name:"TemcoScan Lab",exact:true})).toHaveCount(0);
    });
    await t.test("old tab navigation and API stay pinned after another tab selects a warehouse", async () => {
      await signIn(0); await page.goto(origin); await expect(page.getByRole("complementary", {name:"Current warehouse"})).toContainText(sites[0].name);
      const second = await context.newPage(); await second.goto(origin); await second.getByRole("combobox", {name:"Warehouse",exact:true}).selectOption(sites[1].id); await expect(second.getByRole("complementary", {name:"Current warehouse"})).toContainText(sites[1].name);
      await page.getByRole("link",{name:"Open workflows",exact:true}).click(); await expect(page).toHaveURL(/\/tools\/workflows$/);
      assert.equal(await page.evaluate(() => window.__temcoUiContextV1?.siteId), sites[0].id);
      await expect(page.locator("main").last()).toContainText(sites[0].name);
      const result = await page.evaluate(async () => (await (await fetch("/api/application/sites.mine", {method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json()).result);
      assert.equal(result.activeSiteId, sites[0].id); await second.close();
    });
    await t.test("Receiving starts and persists a local run through the real mobile UI", async () => {
      await page.getByRole("button",{name:"Start Receiving practice",exact:true}).click();
      await expect(page.getByText("Receiving facts",{exact:false}).first()).toBeVisible();
      assert.ok(await owner.workflowRunRecord.count({where:{createdByUserId:users[0].id,siteId:sites[0].id}})>0);
      assert.equal(await owner.dmpOperation.count({where:{actorUserId:users[0].id}}),0);
      assert.equal(await owner.labelIssuance.count({where:{actorUserId:users[0].id}}),0);
    });
    await t.test("guarded full application serves local same-frame Tesseract and Paddle inference", async () => {
      await page.goto(`${origin}/tools/scan-lab`); await expect(page.getByRole("heading",{name:/TemcoScan/})).toBeVisible();
      await page.getByLabel("Input source",{exact:true}).selectOption("upload");
      await page.locator('input[type="file"]').setInputFiles(resolve("public/scan-lab/fixtures/serial-clean.png"));
      await page.getByLabel("Task",{exact:true}).selectOption("ocr");
      await page.getByRole("button",{name:"Compare Tesseract + Paddle · same frame",exact:true}).click();
      await expect(page.getByLabel("tesseract raw text",{exact:true})).toContainText(/SERIAL|MODEL/, { timeout: 90_000 });
      await expect(page.getByLabel("paddle raw text",{exact:true})).toContainText(/SERIAL|MODEL/, { timeout: 90_000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth+1), false);
      assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
    });
  } finally {
    await browser.close(); if (child.exitCode === null) { const stopped=once(child,"exit"); child.kill("SIGTERM"); await stopped; }
    await owner.userSession.updateMany({where:{userId:{in:users.map(u=>u.id)}},data:{revokedAt:new Date()}}); await owner.$disconnect();
  }
});
