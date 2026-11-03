import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { chromium, expect, type Page } from "@playwright/test";
import { hashPassword } from "../lib/auth/passwords";
import { resolve } from "node:path";
import { stableWorkflowJson, validateWorkflowDefinition } from "../lib/workflows/definition";
const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
const publicPilot = process.env.EXPANDED_PUBLIC_QUALIFICATION === "1";
test("integrated mobile warehouse context, platform-only scanner, local workers and Receiving UI", { skip: !url && !publicPilot, timeout: 240_000 }, async t => {
  if (publicPilot) return qualifyDeployedScanner(t);
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID();
  const sites = await Promise.all(["A", "B"].map(n => owner.warehouseSite.create({ data: { slug: `mobile-${ns}-${n.toLowerCase()}`, name: `Synthetic mobile ${n}` } })));
  const password = "Synthetic expanded browser phrase 2026", passwordHash = await hashPassword(password);
  const users = await Promise.all([true, false].map((platform, i) => owner.user.create({ data: { username: `mobile-${ns}-${i}`, displayName: platform ? "Synthetic platform admin" : "Synthetic site manager", pinHash: "disabled:v2", passwordHash, passwordChangedAt: new Date(), isPlatformAdmin: platform, role: "admin" } })));
  for (const user of users) for (const site of sites) await owner.warehouseMembership.create({ data: { userId: user.id, siteId: site.id, roles: { create: { roleId: "warehouse-manager" } } } });
  const definitionId = `mobile-form-${ns}`, versionId = `mobile-form-version-${ns}`;
  const definition = validateWorkflowDefinition({ id: definitionId, versionId, version: 1, configurationVersion: "workflow-local-config-v1", mode: "synthetic", name: "Synthetic reviewed form", steps: [
    { id: "entry", kind: "form", title: "Record a practice value", saveAs: "entry", fields: [{ key: "identifier", label: "Synthetic reviewed identifier", type: "identifier" }] },
    { id: "echo", kind: "action", title: "Echo the captured value", action: { id: "workflow.local.echo", versionId: "workflow-local-echo-v1", configurationVersion: "workflow-local-config-v1", effect: "local", capability: "workflow.read" }, parameters: { identifier: { source: "data", path: ["entry", "identifier"] } } },
  ] });
  await owner.workflowDefinitionRecord.create({ data: { id: definitionId, siteId: sites[0].id, name: definition.name, draft: definition, createdByUserId: users[0].id, updatedByUserId: users[0].id } });
  await owner.workflowDefinitionVersion.create({ data: { id: versionId, siteId: sites[0].id, definitionId, version: 1, definition, contentHash: createHash("sha256").update(stableWorkflowJson(definition)).digest("hex"), createdByUserId: users[0].id } });
  await owner.workflowDefinitionRecord.update({ where: { id: definitionId }, data: { publishedVersionId: versionId } });
  const custodyUnitId = `synthetic-mobile-custody:${ns}`, custodyLpn = `SYNTHETIC-MOBILE-LPN-${ns}`.toUpperCase();
  await owner.warehouseUnit.create({ data: { id: custodyUnitId, siteId: sites[0].id, creationEvidence: "SYNTHETIC-SOURCE-PRIVATE-ORIGIN" } });
  await owner.warehouseIdentifier.create({ data: { siteId: sites[0].id, unitId: custodyUnitId, kind: "lpn", namespace: "wms", value: custodyLpn, rawValue: custodyLpn, evidence: "Synthetic source-private alias evidence" } });
  const reserve = createServer(); reserve.listen(0,"127.0.0.1"); await once(reserve,"listening"); const address = reserve.address(); assert.ok(address && typeof address !== "string"); const port = address.port; await new Promise<void>(r => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`, secret = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env: { ...process.env, DATABASE_URL: url!, NODE_ENV: "production", SESSION_SECRET: secret, TEMCO_PILOT_MODE: "read_only_dmp", TEMCO_SESSION_COOKIE_NAME: "temco_expanded_synthetic", NEXT_PUBLIC_APP_URL: origin, API_RELAY_INTERNAL_URL: "http://127.0.0.1:1" }, stdio: ["ignore","pipe","pipe"] });
  let output = ""; child.stdout.on("data", b => { output = (output + b).slice(-3000); }); child.stderr.on("data", b => { output = (output + b).slice(-3000); });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Pacific/Auckland" }), page = await context.newPage();
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
    await t.test("mobile management surfaces expose approved provider and template controls without upstream contact", async () => { await signIn(0); await verifyManagementUi(page, origin); });
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
    await t.test("published workflow review pins its version and completes a local form on mobile", async () => {
      await page.getByRole("group", { name: definition.name, exact: true }).getByRole("button", { name: "Start published workflow", exact: true }).click();
      await expect(page.getByRole("heading", { name: `Start reviewed version · ${definition.name}`, exact: true })).toBeVisible();
      await expect(page.getByText(`Definition ${versionId}`, { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Start reviewed workflow", exact: true }).click();
      await page.getByLabel("Synthetic reviewed identifier", { exact: true }).fill("SYNTHETIC-REVIEW-001");
      await page.getByRole("button", { name: "Save and continue", exact: true }).click();
      await expect.poll(async () => owner.workflowRunRecord.count({ where: { createdByUserId: users[0].id, definitionVersionId: versionId, status: "completed", siteId: sites[0].id } })).toBe(1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth+1), false);
      assert.equal(await owner.integrationOperation.count({ where: { actorUserId: users[0].id } }), 0);
    });
    await t.test("mobile exact-unit handoff is accepted at its destination without claiming movement", async () => {
      await signIn(0); await page.goto(`${origin}/tools/custody?unitId=${encodeURIComponent(custodyUnitId)}`);
      await expect(page.getByRole("heading", { name: "Warehouse custody", exact: true })).toBeVisible();
      await expect.poll(async () => page.locator("main").last().innerText()).toContain(custodyUnitId);
      await page.getByLabel("Destination warehouse", { exact: true }).selectOption(sites[1].id);
      await page.locator('main input[type="checkbox"]').check();
      await page.getByLabel("Approved description", { exact: true }).fill("Synthetic approved appliance summary");
      await page.getByLabel("Proposal audit note", { exact: true }).fill("Synthetic source approval");
      await page.getByRole("button", { name: "Propose exact-unit transfer", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Transfer · proposed", exact: true })).toBeVisible();
      await page.getByRole("combobox", { name: "Warehouse", exact: true }).selectOption(sites[1].id);
      await expect(page).toHaveURL(origin+"/");
      await expect(page.getByRole("complementary", { name: "Current warehouse" })).toContainText(sites[1].name);
      await page.goto(`${origin}/tools/custody`);
      await page.getByRole("button").filter({ hasText: `proposed · ${custodyUnitId}` }).click();
      await page.getByLabel("Decision audit note", { exact: true }).fill("Synthetic receiving warehouse acceptance");
      await page.getByRole("button", { name: "Accept at destination", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Transfer · accepted", exact: true })).toBeVisible();
      const participation = await owner.warehouseUnitSite.findUniqueOrThrow({ where: { siteId_unitId: { siteId: sites[1].id, unitId: custodyUnitId } } });
      assert.equal(participation.phase, "expected"); assert.equal(participation.holdsCustody, false);
      assert.equal(await owner.warehousePhysicalObservation.count({ where: { unitId: custodyUnitId } }), 0);
      assert.equal(await owner.marsSubmissionIntent.count({ where: { unitId: custodyUnitId } }), 0);
      await page.goto(`${origin}/tools/custody?unitId=${encodeURIComponent(custodyUnitId)}`);
      await expect(page.locator("main").last()).toContainText("Warehouse participation: expected");
      await expect(page.locator("main").last()).not.toContainText("SYNTHETIC-SOURCE-PRIVATE-ORIGIN");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth+1), false);
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

async function qualifyDeployedScanner(t: test.TestContext) {
  const origin = "https://temco-v2.chronchive.com", head = process.env.EXPANDED_EXPECT_SOURCE ?? "2ae6cb2d39d7d685035c469f2383ef56a67df0d2";
  const expectedImage = process.env.EXPANDED_EXPECT_MCP_IMAGE_ID ?? "sha256:db009517e1fcf21d4776a0f6d21dce078a4e9d9cd19a176cf8e49337bd1cc8fa";
  assert.match(head,/^[a-f0-9]{40}$/); assert.match(expectedImage,/^sha256:[a-f0-9]{64}$/);
  const ssh = ["-F", "/Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=12", "vps"];
  const containers = execFileSync("ssh", [...ssh, "docker ps --no-trunc --filter label=com.docker.compose.project=temcotools-v2-pilot-parallel --filter label=com.docker.compose.service=mcp-http --format '{{.ID}}'"], {encoding:"utf8",timeout:30_000}).trim().split(/\s+/); assert.equal(containers.length,1); const container=containers[0]; assert.match(container,/^[a-f0-9]{64}$/);
  const pins = execFileSync("ssh", [...ssh, `docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "com.docker.compose.project"}}' ${container}`], { encoding: "utf8", timeout: 30_000 }).trim();
  assert.equal(pins, `${expectedImage} ${head} temcotools-v2-pilot-parallel`);
  const ns = randomUUID(), password = randomBytes(32).toString("base64url");
  function fixture(mode: "seed" | "select" | "cleanup", extra: Record<string, unknown> = {}) {
    // Only one known pilot container, exact namespace and synthetic identities.
    // Credentials travel through private process stdin; never arguments/stdout.
    const payload = Buffer.from(JSON.stringify({ mode, ns, password, ...extra })).toString("base64url");
    const source = `import assert from 'node:assert/strict';import {PrismaClient} from '@prisma/client';import {PrismaPg} from '@prisma/adapter-pg';import pw from '/app/lib/auth/passwords.ts';
const cfg=JSON.parse(Buffer.from(${JSON.stringify(payload)},'base64url').toString());assert.match(cfg.ns,/^[a-f0-9-]{36}$/);const prefix='synthetic-deployed-scan-'+cfg.ns;const dburl=new URL(process.env.DATABASE_URL);assert.equal(dburl.hostname,'db');assert.equal(dburl.pathname,'/temcotools_v2_pilot_parallel');assert.equal(process.env.NEXT_PUBLIC_APP_URL,'https://temco-v2.chronchive.com');assert.equal(process.env.TEMCO_PILOT_MODE,'read_only_dmp');const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
try{let result={};if(cfg.mode==='seed'){assert.equal(await db.user.count({where:{username:{startsWith:prefix}}}),0);const sites=[];for(const suffix of ['a','b'])sites.push(await db.warehouseSite.create({data:{slug:prefix+'-'+suffix,name:'Synthetic deployed scanner '+suffix.toUpperCase()}}));const users=[];for(const [i,platform]of [true,false].entries())users.push(await db.user.create({data:{username:prefix+'-'+i,displayName:'Synthetic deployed scanner '+i,pinHash:'disabled:v2',passwordHash:await pw.hashPassword(cfg.password),passwordChangedAt:new Date(),role:'admin',isPlatformAdmin:platform}}));for(const user of users)for(const site of sites)await db.warehouseMembership.create({data:{userId:user.id,siteId:site.id,roles:{create:{roleId:'warehouse-manager'}}}});result={sites:sites.map(s=>({id:s.id,name:s.name})),users:users.map(u=>({id:u.id,username:u.username}))};}
else if(cfg.mode==='select'){const user=await db.user.findUniqueOrThrow({where:{username:prefix+'-'+cfg.index}});const site=await db.warehouseSite.findUniqueOrThrow({where:{slug:prefix+'-a'}});const session=await db.userSession.findFirstOrThrow({where:{userId:user.id},orderBy:{createdAt:'desc'}});await db.userSession.update({where:{id:session.id},data:{activeSiteId:site.id}});result={selected:true};}
else{const users=await db.user.findMany({where:{username:{startsWith:prefix}},select:{id:true}}),ids=users.map(u=>u.id);const sites=await db.warehouseSite.findMany({where:{slug:{startsWith:prefix}},select:{id:true}});assert.equal(await db.workflowRunRecord.count({where:{siteId:{in:sites.map(s=>s.id)}}}),0);assert.equal(await db.dmpOperation.count({where:{actorUserId:{in:ids}}}),0);assert.equal(await db.labelIssuance.count({where:{actorUserId:{in:ids}}}),0);await db.identityAudit.deleteMany({where:{OR:[{actorUserId:{in:ids}},{targetUserId:{in:ids}}]}});await db.warehouseMembershipRole.deleteMany({where:{membership:{userId:{in:ids}}}});await db.warehouseMembership.deleteMany({where:{userId:{in:ids}}});await db.user.deleteMany({where:{id:{in:ids}}});await db.officeCommandReceipt.deleteMany({where:{siteId:{in:sites.map(s=>s.id)}}});await db.warehouseSite.deleteMany({where:{id:{in:sites.map(s=>s.id)}}});result={syntheticPeopleRemaining:await db.user.count({where:{username:{startsWith:prefix}}}),syntheticSessionsRemaining:await db.userSession.count({where:{userId:{in:ids}}}),syntheticSitesRemaining:await db.warehouseSite.count({where:{slug:{startsWith:prefix}}}),operationalEffects:0};}console.log(JSON.stringify(result));}finally{await db.$disconnect();}`;
    try { return JSON.parse(execFileSync("ssh", [...ssh, `docker exec -i ${container} node --import tsx --input-type=module`], { input: source, encoding: "utf8", timeout: 45_000, maxBuffer: 1_000_000, stdio: ["pipe", "pipe", "pipe"] })); }
    catch { throw new Error(`The exact synthetic ${mode} failed; private command diagnostics withheld. Namespace ${ns}.`); }
  }
  const data = fixture("seed") as { users: { id: string; username: string }[]; sites: { id: string; name: string }[] };
  const browser = await chromium.launch({ channel: "chrome", headless: true }), context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Pacific/Auckland" }), page = await context.newPage();
  const foreign: string[] = [], errors: string[] = [];
  await context.route("**/*", route => { const u = new URL(route.request().url()); if (u.origin === origin || ["data:", "blob:"].includes(u.protocol)) return route.continue(); if (!["https://static.cloudflareinsights.com"].includes(u.origin)) foreign.push(u.origin); return route.abort(); });
  page.on("pageerror", e => errors.push(e.message));
  async function signIn(i: number) {
    await context.clearCookies(); await page.goto(origin+"/signin");
    await page.getByRole("textbox", { name: "Username", exact: true }).fill(data.users[i].username);
    await page.getByRole("textbox", { name: "Password or passphrase", exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(origin+"/", { timeout: 30_000 }); fixture("select", { index: i }); await page.goto(origin);
  }
  try {
    await t.test("deployed anonymous and local admin cannot open Lab", async () => {
      await page.goto(origin+"/tools/scan-lab"); await expect(page).toHaveURL(origin+"/signin");
      await signIn(1); await page.goto(origin+"/tools/scan-lab"); assert.notEqual(new URL(page.url()).pathname,"/tools/scan-lab"); await expect(page.getByRole("link", {name:"TemcoScan Lab",exact:true})).toHaveCount(0);
    });
    await t.test("deployed management surfaces serve the actual generic executor and template editor", async () => { await signIn(0); await verifyManagementUi(page, origin); });
    await t.test("deployed old tab keeps its warehouse through another tab switch and RSC navigation", async () => {
      await signIn(0); const second=await context.newPage(); await second.goto(origin); await second.getByRole("combobox",{name:"Warehouse",exact:true}).selectOption(data.sites[1].id); await expect(second.getByRole("complementary",{name:"Current warehouse"})).toContainText(data.sites[1].name);
      await page.getByRole("link",{name:"Open workflows",exact:true}).click(); await expect(page).toHaveURL(origin+"/tools/workflows"); assert.equal(await page.evaluate(()=>window.__temcoUiContextV1?.siteId),data.sites[0].id); await expect(page.locator("main").last()).toContainText(data.sites[0].name); await second.close();
    });
    await t.test("deployed real Tesseract and Paddle workers infer the same uploaded synthetic frame", async () => {
      await page.goto(origin+"/tools/scan-lab"); await expect(page.getByRole("heading",{name:/TemcoScan/})).toBeVisible(); await page.getByLabel("Input source",{exact:true}).selectOption("upload"); await page.locator('input[type="file"]').setInputFiles(resolve("public/scan-lab/fixtures/serial-clean.png")); await page.getByLabel("Task",{exact:true}).selectOption("ocr"); await page.getByRole("button",{name:"Compare Tesseract + Paddle · same frame",exact:true}).click();
      await expect(page.getByLabel("tesseract raw text",{exact:true})).toContainText(/SERIAL|MODEL/,{timeout:120_000}); await expect(page.getByLabel("paddle raw text",{exact:true})).toContainText(/SERIAL|MODEL/,{timeout:120_000}); assert.deepEqual(foreign,[]); assert.deepEqual(errors,[]); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      // Retain only synthetic OCR results, never session/credential material.
      console.log(JSON.stringify({publicOrigin:origin,runtimeHead:head,realChrome:true,viewport:390,tesseractRaw:await page.getByLabel("tesseract raw text",{exact:true}).textContent(),paddleRaw:await page.getByLabel("paddle raw text",{exact:true}).textContent(),externalOcrRequests:0,physicalDevice:false}));
    });
  } finally { await browser.close(); const cleanup=fixture("cleanup"); assert.deepEqual(cleanup,{syntheticPeopleRemaining:0,syntheticSessionsRemaining:0,syntheticSitesRemaining:0,operationalEffects:0}); console.log(JSON.stringify({publicSyntheticCleanup:cleanup,ownerUsed:false})); }
}

async function verifyManagementUi(page: Page, origin: string) {
  await page.goto(origin+"/management/connections"); await expect(page.getByRole("heading",{name:"Approved provider activation and named operations",exact:true})).toBeVisible();
  await page.goto(origin+"/management/templates"); await expect(page.getByRole("heading",{name:"Platform defaults and warehouse overrides",exact:true})).toBeVisible();
  await page.goto(origin+"/tools/custody"); await expect(page.getByRole("heading",{name:"Warehouse custody",exact:true})).toBeVisible();
  await expect(page.getByText("No transfers involve this warehouse.",{exact:true})).toBeVisible(); await expect(page.getByText("No unlinked source rows in this warehouse.",{exact:true})).toBeVisible();
  await page.goto(origin+"/admin/payloads"); const load=page.getByRole("button",{name:"Load generic approved-provider executor",exact:true}); await expect(load).toBeEnabled(); await load.click();
  await expect(page.getByLabel("Payload source",{exact:true})).toHaveValue(/createBrowserProviderExecutor/); await expect(page.getByLabel("Payload source",{exact:true})).toHaveValue(/startGenericProvider/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
}
