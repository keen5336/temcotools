import assert from "node:assert/strict";
import test from "node:test";
import { dmpOperationConfigHash, verifyQueuedDmpPayload } from "../../lib/api-relay/payload-policy";

test("queued named-operation configuration cannot silently change under an existing payload grant", async () => {
  const previous = process.env.DMP_API_OPERATIONS;
  try {
    delete process.env.DMP_API_OPERATIONS;
    const captured = dmpOperationConfigHash();
    process.env.DMP_API_OPERATIONS = JSON.stringify({ deliveries: { label: "Synthetic changed operation", method: "POST", path: "/synthetic-only", body: {} } });
    assert.notEqual(dmpOperationConfigHash(), captured);
    await assert.rejects(verifyQueuedDmpPayload({ operationConfigHash: captured }, "https://dmp.test"), /configuration changed/);
    await assert.rejects(verifyQueuedDmpPayload({}, "https://dmp.test"));
  } finally { if (previous === undefined) delete process.env.DMP_API_OPERATIONS; else process.env.DMP_API_OPERATIONS = previous; }
});
