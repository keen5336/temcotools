/** Offline operator entry point; never exposed through an HTTP route. */
import "dotenv/config";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({ options: {
    username: { type: "string" }, purpose: { type: "string", default: "enroll" },
    "expect-host": { type: "string" }, "expect-database": { type: "string" },
    "delivery-file": { type: "string" }, reason: { type: "string" }, apply: { type: "boolean", default: false },
  } });
  const target = new URL(process.env.DATABASE_URL || "");
  if (!values.username || !values["expect-host"] || !values["expect-database"] || target.host !== values["expect-host"] || decodeURIComponent(target.pathname.slice(1)) !== values["expect-database"]) throw new Error("Provide a username and matching --expect-host (including port) and --expect-database. No database change made.");
  if (values.purpose !== "enroll" && values.purpose !== "reset") throw new Error("Purpose must be enroll or reset.");
  const { prisma } = await import("../lib/db");
  try {
    const user = await prisma.user.findUnique({ where: { username: values.username } });
    if (!user?.isActive || user.role !== "admin") throw new Error("An existing active administrator is required.");
    console.log(`Verified target ${target.host}/${values["expect-database"]}; active administrator ${user.username}; operation ${values.purpose}.`);
    if (!values.apply) { console.log("Dry run only. Apply requires --apply, --reason, and an absolute --delivery-file in an existing private directory."); return; }
    const path = values["delivery-file"], reason = values.reason?.trim();
    if (!path || !isAbsolute(path) || !reason || reason.length < 5 || reason.length > 300) throw new Error("Provide an absolute --delivery-file and a reason of 5–300 characters.");
    const parent = dirname(path), stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || await realpath(parent) !== parent) throw new Error("Delivery parent must be a real, owned directory with mode 0700 and no symlink components.");
    // Exclusive creation prevents overwriting existing custody material. Keep
    // the file on an uncertain commit; do not automatically repeat a reset.
    const handle = await open(path, "wx", 0o600);
    try {
      const { issueOperatorCode } = await import("../lib/auth/identity");
      await issueOperatorCode(user.id, values.purpose, reason, async (code, expiresAt) => {
        const base = process.env.NEXT_PUBLIC_APP_URL;
        const link = base ? `${new URL(base).origin}/account/update#${new URLSearchParams({ username: user.username, code })}` : undefined;
        await handle.writeFile(JSON.stringify({ username: user.username, code, expiresAt, link }, null, 2) + "\n");
        await handle.sync();
      });
      console.log("Code committed and written to the private delivery file. Deliver privately, then remove that file after use. Code expires in 30 minutes.");
    } finally { await handle.close(); }
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error("Operator setup did not confirm completion. Verify arguments, target, account state and private delivery file before taking another action. No credentials are printed. Do not automatically retry a reset."); process.exitCode = 1; });
