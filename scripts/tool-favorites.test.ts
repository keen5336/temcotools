import assert from "node:assert/strict";
import test from "node:test";
import { changeFavorites, FavoriteError, parseFavoriteChange } from "../lib/tool-favorites";
import { TOOLS, toolSections, toolsForRole, visibleFavoriteIds } from "../lib/tools";

test("catalog identifiers and destinations are unique", () => {
  assert.equal(new Set(TOOLS.map((t) => t.id)).size, TOOLS.length);
  assert.equal(new Set(TOOLS.map((t) => t.href)).size, TOOLS.length);
});
test("restricted tools follow the current role", () => {
  assert.equal(toolsForRole("user").some((t) => t.id === "users" || t.id === "labels"), false);
  assert.equal(toolsForRole("manager").some((t) => t.id === "labels"), true);
  assert.equal(toolsForRole("manager").some((t) => t.id === "files"), false);
  assert.equal(toolsForRole("admin").some((t) => t.id === "users"), true);
});
test("set operations are idempotent and append new favorites without losing others", () => {
  const set = { action: "set", toolId: "pick-waves", favorite: true } as const;
  const first = changeFavorites(["api-relay"], "user", set);
  assert.deepEqual(first, ["api-relay", "pick-waves"]);
  assert.deepEqual(changeFavorites(first, "user", set), first);
  assert.deepEqual(changeFavorites(first, "user", { ...set, favorite: false }), ["api-relay"]);
});
test("reordering retains a favorite added concurrently in another tab", () => {
  assert.deepEqual(changeFavorites(["mars", "pick-waves", "api-relay"], "user", { action: "reorder", order: ["pick-waves", "mars"] }), ["pick-waves", "mars", "api-relay"]);
});
test("hidden role-specific favorites are retained without leaking into navigation", () => {
  const stored = changeFavorites(["users", "mars", "labels", "pick-waves"], "user", { action: "reorder", order: ["pick-waves", "mars"] });
  assert.deepEqual(stored, ["users", "pick-waves", "labels", "mars"]);
  assert.deepEqual(visibleFavoriteIds(stored, "user"), ["pick-waves", "mars"]);
  assert.deepEqual(visibleFavoriteIds(stored, "admin"), stored);
});
test("stale reorder cannot resurrect a tool another tab removed", () => {
  assert.throws(() => changeFavorites(["mars"], "user", { action: "reorder", order: ["pick-waves", "mars"] }), (e) => e instanceof FavoriteError && e.status === 409);
});
test("unauthorized or unknown tool IDs cannot be starred or reordered", () => {
  for (const toolId of ["users", "not-a-tool", "__proto__"]) {
    assert.throws(() => changeFavorites([], "user", { action: "set", toolId, favorite: true }), (e) => e instanceof FavoriteError && e.status === 403);
  }
});
test("request parsing rejects ambiguous input and discards client authority", () => {
  for (const data of [null, {}, { action: "set", toolId: "mars", favorite: "yes" }, { action: "reorder", order: ["mars", "mars"] }, { action: "reorder", order: [7] }]) assert.throws(() => parseFavoriteChange(data), FavoriteError);
  assert.deepEqual(parseFavoriteChange({ action: "set", toolId: "mars", favorite: true, userId: "someone-else", role: "admin" }), { action: "set", toolId: "mars", favorite: true });
});
test("favorites keep their order and appear only once across dashboard sections", () => {
  const sections = toolSections("user", ["pick-waves", "api-relay", "pick-waves", "users", "retired-tool"]);
  assert.deepEqual(sections.favorites.map((t) => t.id), ["pick-waves", "api-relay"]);
  assert.equal(sections.remaining.some((t) => ["pick-waves", "api-relay", "users"].includes(t.id)), false);
  assert.equal(sections.favorites.length + sections.remaining.length, toolsForRole("user").length);
});
