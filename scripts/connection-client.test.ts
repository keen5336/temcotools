import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { connectionCommand } from "../lib/integrations/client";
test("lost acknowledgements retain only generated command IDs and never substitute an operation selector", async () => {
  const old = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch, crypto: globalThis.crypto };
  const storage: Record<string,string> = {}, seen: Array<{action:string;input:Record<string,unknown>}> = [];
  let fail = true;
  Object.defineProperty(globalThis,"window",{value:{__temcoUiContextV1:{context:"synthetic-context",siteId:"synthetic-site"}},configurable:true});
  Object.defineProperty(globalThis,"sessionStorage",{value:{getItem:(key:string)=>storage[key]??null,setItem:(key:string,value:string)=>{storage[key]=value;},removeItem:(key:string)=>{delete storage[key];}},configurable:true});
  Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
  globalThis.fetch = async (url,init) => { const input=JSON.parse(String(init?.body)),action=String(url).split("/").at(-1)!;seen.push({action,input});return Response.json(fail?{error:"Synthetic lost ACK"}:{result:input},{status:fail?503:200}); };
  try {
    for (const action of ["connections.operation.get","connections.operation.claim","connections.operation.cancel"]) {
      await assert.rejects(connectionCommand(action,{providerId:"provider",expectedRevision:1,operationId:"original-A"}));
      fail=false;await connectionCommand(action,{providerId:"provider",expectedRevision:1,operationId:"original-B"});assert.equal(seen.at(-1)!.input.operationId,"original-B");fail=true;
    }
    await assert.rejects(connectionCommand("connections.operation.prepare",{providerId:"provider",actionVersionId:"action-v1",operationId:"new-intent-A",input:{item:"PRIVATE-SYNTHETIC-INPUT"}}));
    fail=false;await connectionCommand("connections.operation.prepare",{providerId:"provider",actionVersionId:"action-v1",operationId:"new-intent-B",input:{item:"PRIVATE-SYNTHETIC-INPUT"}});assert.equal(seen.at(-1)!.input.operationId,"new-intent-A");
    fail=true;await assert.rejects(connectionCommand("connections.operation.reconcile",{operationId:"original-A",commandId:"command-A",outcome:"verified_not_applied",evidence:"Synthetic evidence"}));
    fail=false;await connectionCommand("connections.operation.reconcile",{operationId:"original-B",commandId:"command-B",outcome:"verified_not_applied",evidence:"Synthetic evidence"});assert.equal(seen.at(-1)!.input.operationId,"original-B");assert.equal(seen.at(-1)!.input.commandId,"command-B");
    assert.equal(JSON.stringify(storage).includes("PRIVATE-SYNTHETIC-INPUT"),false);
  } finally { for (const key of ["window","sessionStorage","crypto"] as const) { if(old[key]===undefined)Reflect.deleteProperty(globalThis,key);else Object.defineProperty(globalThis,key,{value:old[key],configurable:true}); } globalThis.fetch=old.fetch; }
});
