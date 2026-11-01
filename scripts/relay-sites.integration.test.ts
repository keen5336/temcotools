import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once, EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiRelayServer, controlKey } from "./api-relay/server.mjs";
import { SITE_PROFILE_BINDING_DIRECTIVE } from "../lib/relay-sites/contract";
type SyntheticSocket = EventEmitter & { send(data: string): void; terminate(): void };
const WebSocket = createRequire(import.meta.url)("ws") as new (url: string, options: { origin: string }) => SyntheticSocket;

test("real PostgreSQL site mappings and shared MCP commands preserve current authority and pinned queue policy", { skip: !process.env.DATABASE_URL }, async t => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_profiles_test", "This suite permits only its dedicated synthetic profile database.");
  const [{ prisma }, sites, payloads, policy, { createApplicationMcpServer }, { resolvePrincipal, CURRENT_USER_SELECT }, { loadSitePayload }] = await Promise.all([
    import("../lib/db"), import("../lib/relay-sites/service"), import("../lib/payloads/service"), import("../lib/api-relay/payload-policy"), import("../lib/application/mcp"), import("../lib/auth/principal"), import("../lib/relay-sites/loader"),
  ]);
  const suffix = randomUUID(), origin = `https://synthetic-${suffix}.example.invalid`, profileId = `profile-${suffix}`, payloadId = `adapter-${suffix}`;
  const rpId = `rp-${suffix}`, unpublishedId = `draft-${suffix}`, legacyId = `legacy-${suffix}`;
  const oldOrigins = process.env.DMP_ORIGINS; process.env.DMP_ORIGINS = origin;
  const bundle = await prisma.roleBundle.create({ data: { name: `Synthetic site bundle ${suffix}`, capabilities: ["payloads.manage", "workflow.read"] } });
  const user = await prisma.user.create({ data: { username: `site-admin-${suffix}`, displayName: "Synthetic mapping administrator", pinHash: "disabled:v2", role: "admin", roleBundles: { create: { bundleId: bundle.id } } } });
  const at = new Date();
  const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, lastActivityAt: at, lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, expiresAt: new Date(at.getTime() + 60 * 60_000), deviceLabel: "Synthetic authority fixture, not a hardware ceremony" } });
  const principal = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
  assert.ok(principal); Object.assign(principal, { sessionId: session.id, strongAuthenticatedAt: at.getTime(), mfaVerifiedAt: at.getTime() });
  let profile: Awaited<ReturnType<typeof sites.saveSiteProfile>>;
  const base = { id: profileId, name: "Synthetic DMP mapping", origin, pathPrefix: "/warehouse", purpose: "dmp_relay", payloadId, enabled: false, note: "Synthetic mapping qualification" };
  const source = `${SITE_PROFILE_BINDING_DIRECTIVE}\nglobalThis.syntheticAdapterVersion='one';`;
  let captured: Awaited<ReturnType<typeof policy.authorizeDmpPayload>>;
  const extraProfiles: string[] = [];
  try {
    const draft = await payloads.createPayload(principal, { id: payloadId, name: "Synthetic DMP adapter", purpose: "dmp_relay", targetOrigins: [origin], source, protocolVersion: 1, operationNames: ["session"], note: "Synthetic adapter draft" });
    const published = await payloads.publishPayload(principal, { id: payloadId, expectedRevision: draft.revision, note: "Synthetic explicit publication", reviewedNoSecrets: true });
    const rp = await payloads.createPayload(principal, { id: rpId, name: "Synthetic RP adapter", purpose: "route_planner_relay", targetOrigins: [origin], source: "globalThis.syntheticRpReview=true;", protocolVersion: 1, operationNames: [], note: "Synthetic RP draft" });
    await payloads.publishPayload(principal, { id: rpId, expectedRevision: rp.revision, note: "Synthetic RP publication", reviewedNoSecrets: true });
    await payloads.createPayload(principal, { id: unpublishedId, name: "Synthetic private draft", purpose: "dmp_relay", targetOrigins: [origin], source: "globalThis.privateDraftMustNotBeServed=true;", protocolVersion: 1, operationNames: [], note: "Synthetic unpublished" });

    await t.test("admin current-session/MFA and strict mapping contracts; disabled never falls back", async () => {
      await assert.rejects(sites.saveSiteProfile({ ...principal, role: "manager" }, { ...base, expectedRevision: null }));
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, expectedRevision: null, source: "unrequested arbitrary source" }));
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, expectedRevision: null, origin: `${origin}/path` }));
      profile = await sites.saveSiteProfile(principal, { ...base, expectedRevision: null });
      await assert.rejects(sites.resolveSitePayload({ origin, pathname: "/warehouse/day" }), /disabled/);
      profile = await sites.setSiteProfileEnabled(principal, { id: profileId, expectedRevision: profile.revision, enabled: true, note: "Synthetic enable" });
      const resolved = await sites.resolveSitePayload({ origin, pathname: "/warehouse/day" });
      assert.equal(resolved.version.id, published.published.id); assert.equal(resolved.version.source, source);
      captured = await policy.authorizeDmpPayload({ payloadId, versionId: resolved.version.id, contentHash: resolved.version.contentHash, profileBinding: resolved.profileBinding }, origin);
      assert.deepEqual(captured.profileBinding, resolved.profileBinding);
      assert.equal((await policy.verifyQueuedDmpPayload(captured, origin)).versionId, resolved.version.id);
      await prisma.userSession.update({ where: { id: session.id }, data: { mfaVerifiedAt: new Date(at.getTime() - 11 * 60_000) } });
      await assert.rejects(sites.setSiteProfileEnabled(principal, { id: profileId, expectedRevision: profile.revision, enabled: false, note: "Stale MFA must deny" }), /authenticator|recovery code/);
      await prisma.userSession.update({ where: { id: session.id }, data: { mfaVerifiedAt: at } });
    });
    await t.test("CAS rejects stale/concurrent full snapshots without losing mapping revocation", async () => {
      const stale = profile.revision;
      profile = await sites.setSiteProfileEnabled(principal, { id: profileId, expectedRevision: stale, enabled: false, note: "Disable before stale snapshot" });
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, enabled: true, expectedRevision: stale }), /changed/);
      assert.equal((await prisma.siteProfile.findUniqueOrThrow({ where: { id: profileId } })).enabled, false);
      await assert.rejects(policy.verifyQueuedDmpPayload(captured, origin), /disabled/);
      profile = await sites.saveSiteProfile(principal, { ...base, enabled: true, expectedRevision: profile.revision });
      await assert.rejects(policy.verifyQueuedDmpPayload(captured, origin), /mapping|binding|changed/i);
      const outcomes = await Promise.allSettled(["A", "B"].map(name => sites.saveSiteProfile(principal, { ...base, enabled: true, name: `Synthetic concurrent ${name}`, expectedRevision: profile.revision })));
      assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
      profile = await prisma.siteProfile.findUniqueOrThrow({ where: { id: profileId } });
      const resolved = await sites.resolveSitePayload({ origin, pathname: "/warehouse/day" });
      captured = await policy.authorizeDmpPayload({ payloadId, versionId: resolved.version.id, contentHash: resolved.version.contentHash, profileBinding: resolved.profileBinding }, origin);
    });
    await t.test("new publication leaves accepted version pinned; disable and wrong-system grants fail closed", async () => {
      const current = await payloads.getPayload(principal, payloadId);
      const edited = await payloads.savePayloadDraft(principal, { id: payloadId, name: current.name, purpose: "dmp_relay", targetOrigins: [origin], source: `${SITE_PROFILE_BINDING_DIRECTIVE}\nglobalThis.syntheticAdapterVersion='two';`, protocolVersion: 1, operationNames: ["session"], expectedRevision: current.revision, note: "Synthetic second draft" });
      const second = await payloads.publishPayload(principal, { id: payloadId, expectedRevision: edited.revision, note: "Synthetic second publication", reviewedNoSecrets: true });
      assert.notEqual(second.published.id, captured.versionId);
      assert.equal((await policy.verifyQueuedDmpPayload(captured, origin)).versionId, captured.versionId);
      const disabled = await payloads.setPayloadEnabled(principal, { id: payloadId, expectedRevision: second.payload.revision, enabled: false, note: "Synthetic adapter disabled" });
      await assert.rejects(policy.verifyQueuedDmpPayload(captured, origin), /disabled/);
      const unavailable = await loadSitePayload(new Request(`https://temco.invalid/api/connect-temco/loader?origin=${encodeURIComponent(origin)}&pathname=/warehouse/day`));
      assert.equal(unavailable.headers.get("X-Temco-Connect-State"), "site_unpublished"); assert.ok(!(await unavailable.text()).includes("syntheticAdapterVersion"));
      await payloads.setPayloadEnabled(principal, { id: payloadId, expectedRevision: disabled.revision, enabled: true, note: "Synthetic adapter restored" });
      profile = await sites.saveSiteProfile(principal, { ...base, purpose: "route_planner_relay", payloadId: rpId, enabled: true, expectedRevision: profile.revision });
      const rpResolved = await sites.resolveSitePayload({ origin, pathname: "/warehouse/day" });
      await assert.rejects(policy.authorizeDmpPayload({ payloadId: rpId, versionId: rpResolved.version.id, contentHash: rpResolved.version.contentHash, profileBinding: rpResolved.profileBinding }, origin));
      await assert.rejects(payloads.createPayload(principal, { id: `rp-unsafe-${suffix}`, name: "Synthetic unsafe RP", purpose: "route_planner_relay", targetOrigins: [origin], source: "void 0;", protocolVersion: 1, operationNames: ["deliveries"], note: "No inferred DMP authority" }), /no DMP|no.*operations/);
    });
    await t.test("overlaps including removed tombstones have practical explicit same-ID restore", async () => {
      const overlapId = `overlap-${suffix}`;
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, id: overlapId, pathPrefix: "/", expectedRevision: null }), /overlap/);
      profile = await sites.removeSiteProfile(principal, { id: profileId, expectedRevision: profile.revision, note: "Synthetic remove retains denial" });
      await assert.rejects(sites.resolveSitePayload({ origin, pathname: "/warehouse/day" }), /disabled/);
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, enabled: true, expectedRevision: profile.revision }), /Explicitly restore/);
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, id: overlapId, pathPrefix: "/", expectedRevision: null }), /overlap/);
      profile = await sites.saveSiteProfile(principal, { ...base, enabled: true, expectedRevision: profile.revision, restoreRemoved: true });
      assert.equal(profile.removedAt, null); assert.equal((await sites.resolveSitePayload({ origin, pathname: "/warehouse/day" })).profileBinding.profileId, profileId);
      // Deliberately emulate inconsistent legacy/manual rows to verify public
      // resolution never chooses an enabled fallback over a disabled overlap.
      extraProfiles.push(overlapId);
      await prisma.siteProfile.create({ data: { id: overlapId, name: "Synthetic inconsistent overlap", origin, pathPrefix: "/", purpose: "dmp_relay", payloadId, enabled: false, createdByUserId: user.id, updatedByUserId: user.id } });
      await assert.rejects(sites.resolveSitePayload({ origin, pathname: "/warehouse/day" }), /Ambiguous/);
      const ambiguous = await loadSitePayload(new Request(`https://temco.invalid/api/connect-temco/loader?origin=${encodeURIComponent(origin)}&pathname=/warehouse/day`));
      assert.equal(ambiguous.headers.get("X-Temco-Connect-State"), "site_ambiguous"); assert.ok(!(await ambiguous.text()).includes("syntheticAdapterVersion"));
      await prisma.siteProfile.delete({ where: { id: overlapId } });
    });
    await t.test("unpublished mappings and wrong origin/path never expose drafts or fall back", async () => {
      const unpublishedProfile = `unpublished-${suffix}`; extraProfiles.push(unpublishedProfile);
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, id: unpublishedProfile, pathPrefix: "/unpublished", payloadId: unpublishedId, enabled: true, expectedRevision: null }), /published/);
      await prisma.siteProfile.create({ data: { id: unpublishedProfile, name: "Synthetic inconsistent unpublished", origin, pathPrefix: "/unpublished", purpose: "dmp_relay", payloadId: unpublishedId, enabled: true, createdByUserId: user.id, updatedByUserId: user.id } });
      for (const [pathname, expected] of [["/unpublished", "site_unpublished"], ["/other", "site_unsupported"]]) {
        const response = await loadSitePayload(new Request(`https://temco.invalid/api/connect-temco/loader?origin=${encodeURIComponent(origin)}&pathname=${pathname}`));
        assert.equal(response.headers.get("X-Temco-Connect-State"), expected); assert.ok(!(await response.text()).includes("privateDraftMustNotBeServed"));
      }
      await assert.rejects(sites.resolveSitePayload({ origin: "https://another-synthetic.invalid", pathname: "/warehouse/day" }), /not configured/);
      const malformed = await loadSitePayload(new Request(`https://temco.invalid/api/connect-temco/loader?origin=${encodeURIComponent(origin)}&pathname=/warehouse/day&query=synthetic-secret`));
      assert.equal(malformed.headers.get("X-Temco-Connect-State"), "site_profile_invalid"); assert.ok(!(await malformed.text()).includes("synthetic-secret"));
    });
    await t.test("unaware legacy DMP remains available but cannot activate or bypass a mapped binding", async () => {
      const legacySource = "globalThis.syntheticUnawareLegacy=true;";
      const legacyDraft = await payloads.createPayload(principal, { id: legacyId, name: "Synthetic historical DMP", purpose: "dmp_relay", targetOrigins: [origin], source: legacySource, protocolVersion: 1, operationNames: ["session"], note: "Synthetic unaware legacy draft" });
      const legacy = await payloads.publishPayload(principal, { id: legacyId, expectedRevision: legacyDraft.revision, note: "Synthetic historical publication", reviewedNoSecrets: true });
      const legacyProfileId = `legacy-profile-${suffix}`; extraProfiles.push(legacyProfileId);
      let legacyProfile = await sites.saveSiteProfile(principal, { ...base, id: legacyProfileId, payloadId: legacyId, pathPrefix: "/legacy", enabled: false, expectedRevision: null });
      await assert.rejects(sites.setSiteProfileEnabled(principal, { id: legacyProfileId, expectedRevision: legacyProfile.revision, enabled: true, note: "Unaware source cannot activate" }), /first-line declaration/);
      await assert.rejects(sites.saveSiteProfile(principal, { ...base, id: legacyProfileId, payloadId: legacyId, pathPrefix: "/legacy", enabled: true, expectedRevision: legacyProfile.revision }), /first-line declaration/);
      // Defensive public check for an inconsistent mapping injected outside the
      // shared writer. Existing immutable source itself remains unchanged.
      await prisma.siteProfile.update({ where: { id: legacyProfileId }, data: { enabled: true } });
      await assert.rejects(sites.resolveSitePayload({ origin, pathname: "/legacy/day" }), /first-line declaration/);
      const unbound = await policy.authorizeDmpPayload({ payloadId: legacyId, versionId: legacy.published.id, contentHash: legacy.published.contentHash }, origin);
      assert.equal(unbound.profileBinding, undefined);
      assert.equal((await payloads.getPublishedVersion(legacyId, legacy.published.id, legacy.published.contentHash)).source, legacySource);
      const declared = await payloads.savePayloadDraft(principal, { id: legacyId, name: "Synthetic declared DMP", purpose: "dmp_relay", targetOrigins: [origin], source: `${SITE_PROFILE_BINDING_DIRECTIVE}\n${legacySource}`, protocolVersion: 1, operationNames: ["session"], expectedRevision: legacy.payload.revision, note: "Synthetic trusted-admin declaration; not semantic source proof" });
      const aware = await payloads.publishPayload(principal, { id: legacyId, expectedRevision: declared.revision, note: "Synthetic declared publication", reviewedNoSecrets: true });
      legacyProfile = await sites.setSiteProfileEnabled(principal, { id: legacyProfileId, expectedRevision: legacyProfile.revision, enabled: true, note: "Explicit reviewed binding contract activation" });
      const active = await sites.resolveSitePayload({ origin, pathname: "/legacy/day" });
      const bound = await policy.authorizeDmpPayload({ payloadId: legacyId, versionId: aware.published.id, contentHash: aware.published.contentHash, profileBinding: active.profileBinding }, origin);
      await assert.rejects(policy.authorizeDmpPayload({ payloadId: legacyId, versionId: legacy.published.id, contentHash: legacy.published.contentHash, profileBinding: { ...active.profileBinding, versionId: legacy.published.id, contentHash: legacy.published.contentHash } }, origin), /first-line declaration/);
      const rolled = await payloads.rollbackPayload(principal, { id: legacyId, expectedRevision: aware.payload.revision, versionId: legacy.published.id, note: "Synthetic rollback to unaware source must deny mapped work" });
      await assert.rejects(sites.resolveSitePayload({ origin, pathname: "/legacy/day" }), /first-line declaration/);
      await assert.rejects(policy.verifyQueuedDmpPayload(bound, origin), /first-line declaration/);
      await payloads.rollbackPayload(principal, { id: legacyId, expectedRevision: rolled.revision, versionId: aware.published.id, note: "Restore synthetic aware publication" });
    });
    await t.test("actual local broker retains the binding and rejects a queued request after mapping disable", async () => {
      const resolved = await sites.resolveSitePayload({ origin, pathname: "/warehouse/day" });
      const grant = await policy.authorizeDmpPayload({ payloadId, versionId: resolved.version.id, contentHash: resolved.version.contentHash, profileBinding: resolved.profileBinding }, origin);
      const secret = "synthetic-site-queue-secret-not-a-deployed-key";
      const factory = createApiRelayServer as unknown as (options: { secret: string; allowedOrigins: string[]; maxConcurrent: number; authorize: (owner: unknown, context: Record<string, unknown>) => Promise<boolean> }) => { server: Server; close(): Promise<void> };
      let checks = 0;
      const relay = factory({ secret, allowedOrigins: [origin], maxConcurrent: 1, authorize: async (_owner, context) => { checks++; try { await policy.verifyQueuedDmpPayload(context.payloadGrant, String(context.origin)); return true; } catch { return false; } } });
      relay.server.listen(0, "127.0.0.1"); await once(relay.server, "listening"); const address = relay.server.address(); assert.ok(address && typeof address !== "string");
      const owner = { userId: user.id, sessionId: session.id };
      const control = async (action: string, data: Record<string, unknown> = {}) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/control`, { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Relay-Key": controlKey(secret) }, body: JSON.stringify({ action, owner, ...data }), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200); return response.json();
      };
      const messages: Record<string, unknown>[] = [];
      let socket: SyntheticSocket | undefined;
      const until = async (predicate: () => boolean | Promise<boolean>) => { for (let attempt = 0; attempt < 150; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Synthetic local broker did not reach the expected queue state."); };
      try {
        const paired = await control("pair", { origin, identity: { method: "GET", path: "/synthetic/identity", timeoutMs: 1000 }, subjectPath: "subject", payloadGrant: grant });
        socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/api-relay/ws`, { origin });
        socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
        await once(socket, "open"); socket.send(JSON.stringify({ type: "pair", token: paired.token }));
        await until(() => messages.some(message => message.type === "paired"));
        const connectionId = messages.find(message => message.type === "paired")!.connectionId;
        socket.send(JSON.stringify({ type: "identity", subject: "synthetic-subject" })); await until(() => messages.some(message => message.type === "ready"));
        const first = control("request", { connectionId, operation: "session", request: { method: "GET", path: "/synthetic-held", timeoutMs: 3000 } });
        await until(() => messages.some(message => message.type === "request"));
        const second = control("request", { connectionId, operation: "session", request: { method: "GET", path: "/synthetic-queued", timeoutMs: 3000 } });
        await until(async () => (await control("connections")).connections.some((connection: { id: string; pending: number }) => connection.id === connectionId && connection.pending === 2));
        profile = await sites.setSiteProfileEnabled(principal, { id: profileId, expectedRevision: profile.revision, enabled: false, note: "Disable while synthetic second request queued" });
        const inFlight = messages.find(message => message.type === "request")!;
        socket.send(JSON.stringify({ type: "result", requestId: inFlight.requestId, ok: true, status: 200, body: "synthetic first response", subject: "synthetic-subject" }));
        const [accepted, denied] = await Promise.all([first, second]);
        assert.equal(accepted.ok, true); assert.equal(accepted.dispatchState, "dispatched");
        assert.equal(denied.ok, false); assert.equal(denied.dispatchState, "not_dispatched");
        assert.equal(messages.filter(message => message.type === "request").length, 1); assert.ok(checks >= 2);
        profile = await sites.setSiteProfileEnabled(principal, { id: profileId, expectedRevision: profile.revision, enabled: true, note: "Restore synthetic mapping after queue proof" });
      } finally { socket?.terminate(); await relay.close(); }
    });
    await t.test("real SDK uses canonical strict input schemas and same current authority", async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let sdkPrincipal = principal;
      const server = createApplicationMcpServer(() => Promise.resolve(sdkPrincipal));
      const client = new Client({ name: "Synthetic site MCP", version: "1" });
      await server.connect(serverTransport); await client.connect(clientTransport);
      try {
        const info = await client.callTool({ name: "application_action_info", arguments: { action: "relay.sites.save" } });
        assert.equal(info.isError, undefined); assert.match(JSON.stringify(info), /expectedRevision/); assert.match(JSON.stringify(info), /restoreRemoved/);
        const result = await client.callTool({ name: "application_action", arguments: { action: "relay.sites.list", input: {} } });
        assert.equal(result.isError, undefined); assert.match(JSON.stringify(result), new RegExp(profileId));
        const invalid = await client.callTool({ name: "application_action", arguments: { action: "relay.sites.save", input: { ...base, expectedRevision: profile.revision, source: "arbitrary execution forbidden" } } });
        assert.equal(invalid.isError, true);
        const grant = await prisma.appAccessGrant.create({ data: { tokenHash: randomUUID(), userId: user.id, sessionId: session.id, authVersion: user.authVersion, clientName: "Synthetic narrowed grant", scopes: ["workflow.read"], expiresAt: session.expiresAt } });
        await assert.rejects(sites.listSiteProfiles({ ...principal, grantId: grant.id }), /permission/);
        // Mapping administrators can copy the universal injector in the UI
        // without warehouse-read authority; MCP must expose the same action.
        const payloadOnly = await prisma.appAccessGrant.create({ data: { tokenHash: randomUUID(), userId: user.id, sessionId: session.id, authVersion: user.authVersion, clientName: "Synthetic payload-only administrator", scopes: ["payloads.manage"], expiresAt: session.expiresAt } });
        const oldAppOrigin = process.env.NEXT_PUBLIC_APP_URL;
        try {
          process.env.NEXT_PUBLIC_APP_URL = "https://synthetic-temco.example.invalid";
          sdkPrincipal = { ...principal, grantId: payloadOnly.id, capabilities: ["payloads.manage"] };
          assert.ok((await sites.listSiteProfiles(sdkPrincipal)).profiles.length > 0);
          const catalog = await client.callTool({ name: "application_actions", arguments: { prefix: "relay.connect." } });
          assert.match(JSON.stringify(catalog), /relay.connect.bookmarklet/);
          const bookmark = await client.callTool({ name: "application_action", arguments: { action: "relay.connect.bookmarklet", input: {} } });
          assert.equal(bookmark.isError, undefined); assert.match(JSON.stringify(bookmark), /javascript:/);
          await prisma.appAccessGrant.update({ where: { id: payloadOnly.id }, data: { revokedAt: new Date() } });
          const denied = await client.callTool({ name: "application_action", arguments: { action: "relay.connect.bookmarklet", input: {} } });
          assert.equal(denied.isError, true);
        } finally {
          sdkPrincipal = principal;
          if (oldAppOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = oldAppOrigin;
        }
        await prisma.userRoleBundle.delete({ where: { userId_bundleId: { userId: user.id, bundleId: bundle.id } } });
        const revoked = await client.callTool({ name: "application_action", arguments: { action: "relay.sites.list", input: {} } });
        assert.equal(revoked.isError, true);
        await prisma.userRoleBundle.create({ data: { userId: user.id, bundleId: bundle.id } });
        await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
        await assert.rejects(sites.saveSiteProfile(principal, { ...base, enabled: true, expectedRevision: profile.revision }), /session/);
      } finally { await client.close(); await server.close(); }
    });
    const audits = await prisma.identityAudit.findMany({ where: { actorUserId: user.id, action: { startsWith: "site_profile_" } } });
    assert.ok(audits.length >= 7); assert.ok(audits.every(row => !row.reason?.includes("globalThis") && row.sessionId === session.id));
  } finally {
    if (oldOrigins === undefined) delete process.env.DMP_ORIGINS; else process.env.DMP_ORIGINS = oldOrigins;
    await prisma.siteProfile.deleteMany({ where: { id: { in: [profileId, ...extraProfiles] } } });
    await prisma.payload.updateMany({ where: { id: { in: [payloadId, rpId, unpublishedId, legacyId] } }, data: { publishedVersionId: null } });
    await prisma.payloadAudit.deleteMany({ where: { payloadId: { in: [payloadId, rpId, unpublishedId, legacyId] } } });
    await prisma.payloadVersion.deleteMany({ where: { payloadId: { in: [payloadId, rpId, unpublishedId, legacyId] } } });
    await prisma.payload.deleteMany({ where: { id: { in: [payloadId, rpId, unpublishedId, legacyId] } } });
    await prisma.identityAudit.deleteMany({ where: { actorUserId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.roleBundle.delete({ where: { id: bundle.id } });
    await prisma.$disconnect();
  }
});
