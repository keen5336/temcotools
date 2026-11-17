/* eslint-disable @typescript-eslint/no-explicit-any -- These protocol fixtures inspect heterogeneous JSON responses with runtime assertions. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import WebSocket from "ws";
import { once } from "node:events";
import { createRelayServer } from "../label-relay/server.mjs";
const base = process.env.MCP_TEST_APP_URL, database = process.env.MCP_TEST_DATABASE_URL;

test("actual HTTP OAuth, modern/legacy MCP, complete app actions and per-device authorization", { skip: !base || !database }, async t => {
  assert.equal(base, "http://127.0.0.1:33022"); const url = new URL(database!); assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"55477");assert.equal(url.pathname,"/mcp_qa");
  process.env.DATABASE_URL = database; process.env.NEXT_PUBLIC_APP_URL = base; process.env.SESSION_SECRET = "synthetic-mcp-test-session-secret-long-enough";
  const { prisma } = await import("../../lib/db"); const { hashPassword } = await import("../../lib/auth/passwords");
  const run = randomUUID().slice(0,8), prefix=`mcp-${run}-`, password="Synthetic MCP cedar path 81";
  const secretHash = await hashPassword(password);
  async function user(name: string, role: "admin"|"user"|"manager" = "admin") { return prisma.user.create({ data:{ username:prefix+name,displayName:name,role,pinHash:"disabled:password",passwordHash:secretHash,passwordEnrolledAt:new Date(),legacyDisabledAt:new Date() } }); }
  const owner=await user("admin"), manager=await user("manager","manager"), staff=await user("staff","user");await user("backup");
  const clients: {close:()=>Promise<void>}[]=[];
  async function request(path:string,options: {cookie?:string;body?:unknown;token?:string;origin?:string|null;method?:string;form?:URLSearchParams}={}) {
    const headers:Record<string,string>={};if(options.cookie)headers.Cookie=options.cookie;if(options.token)headers.Authorization=`Bearer ${options.token}`;
    if(options.body!==undefined || options.form) {if(options.origin!==null)headers.Origin=options.origin||base!;headers["Content-Type"]=options.form?"application/x-www-form-urlencoded":"application/json";}
    return fetch(base+path,{method:options.method || (options.body===undefined&&!options.form?"GET":"POST"),headers,body:options.form|| (options.body===undefined?undefined:JSON.stringify(options.body)),redirect:"manual"});
  }
  async function login(name:string) {const res=await request("/api/auth/login",{body:{username:name,password}});assert.equal(res.status,200);return res.headers.get("set-cookie")!.split(";")[0];}
  let browser=await login(owner.username);const managerCookie=await login(manager.username),staffCookie=await login(staff.username);
  async function pending(scopes="temco.read temco.write",authMethod="none") {
    const registered=await request("/oauth/register",{body:{client_name:`Synthetic ${run}`,redirect_uris:["http://127.0.0.1:39001/callback"],token_endpoint_auth_method:authMethod}});assert.equal(registered.status,201);
    const client=await registered.json();const verifier=randomBytes(32).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url");
    const params=new URLSearchParams({client_id:client.client_id,response_type:"code",redirect_uri:client.redirect_uris[0],resource:base+"/mcp",scope:scopes,state:"synthetic-state",code_challenge:challenge,code_challenge_method:"S256"});
    const auth=await request("/oauth/authorize?"+params);assert.equal(auth.status,302);const consent=new URL(auth.headers.get("location")!);return{client,verifier,consent,requestId:consent.searchParams.get("requestId")!};
  }
  async function approved(scopes="temco.read temco.write",cookie=browser,authMethod="none") {
    const item=await pending(scopes,authMethod);const view=await request(item.consent.pathname+item.consent.search,{cookie});assert.equal(view.status,200);assert.ok((await view.text()).includes("Authorize TemcoTools MCP"));
    const decision=await request("/api/account/mcp/consent",{cookie,body:{requestId:item.requestId,allow:true,scopes:scopes.split(" ")}});assert.equal(decision.status,200);
    const target=new URL((await decision.json()).redirectTo);assert.equal(target.searchParams.get("state"),"synthetic-state");assert.equal(target.searchParams.get("iss"),base);
    return {...item,code:target.searchParams.get("code")!};
  }
  async function exchange(item:Awaited<ReturnType<typeof approved>>,verifier=item.verifier,resource=base+"/mcp") {
    return request("/oauth/token",{form:new URLSearchParams({grant_type:"authorization_code",client_id:item.client.client_id,redirect_uri:item.client.redirect_uris[0],resource,code:item.code,code_verifier:verifier,...(item.client.client_secret?{client_secret:item.client.client_secret}:{})})});
  }
  type Tokens={access_token:string;refresh_token:string;token_type:string;expires_in:number};
  let full:Tokens,read:Tokens,fullClient:Awaited<ReturnType<typeof approved>>,readClient:Awaited<ReturnType<typeof approved>>;
  const modern=(token:string)=>{const client=new Client({name:"synthetic-modern",version:"1"});clients.push(client);return{client,transport:new StreamableHTTPClientTransport(new URL(base+"/mcp"),{requestInit:{headers:{Authorization:`Bearer ${token}`}}})};};
  function body(value:unknown):any {const result=value as {content:{type:string;text?:string}[];isError?:boolean};assert.ok(!result.isError, "MCP action returned an error");return JSON.parse(result.content.find(item=>item.type==="text")!.text!);}
  let modernClient:Client;
  try {
    await t.test("discovery, unauthenticated denial, non-admin consent and browser session binding",async()=>{
      assert.equal((await request("/.well-known/oauth-authorization-server")).status,200);const meta=await(await request("/.well-known/oauth-protected-resource/mcp")).json();assert.equal(meta.resource,base+"/mcp");
      const unauthorized=await request("/mcp",{cookie:browser,body:{jsonrpc:"2.0",id:1,method:"tools/list"}});assert.equal(unauthorized.status,401);assert.ok(unauthorized.headers.get("www-authenticate")?.includes("resource_metadata"));
      for(const cookie of [staffCookie,managerCookie]){const p=await pending();const page=await request(p.consent.pathname+p.consent.search,{cookie});assert.ok((await page.text()).includes("only to administrators"));const denied=await request("/api/account/mcp/consent",{cookie,body:{requestId:p.requestId,allow:true,scopes:["temco.read","temco.write"]}});assert.equal(denied.status,403);}
      const item=await pending();const anonymous=await request(item.consent.pathname+item.consent.search);assert.equal(anonymous.status,307);assert.ok(anonymous.headers.get("location")!.includes("returnTo="));
      await request(item.consent.pathname+item.consent.search,{cookie:browser});const other=await login(owner.username);const switched=await request("/api/account/mcp/consent",{cookie:other,body:{requestId:item.requestId,allow:true,scopes:["temco.read","temco.write"]}});assert.equal(switched.status,400);
      const csrf=await request("/api/account/mcp/consent",{cookie:browser,origin:"https://evil.example",body:{requestId:item.requestId,allow:true,scopes:["temco.read"]}});assert.equal(csrf.status,403);
    });
    await t.test("PKCE, exact resource, single-use code and independent devices",async()=>{
      fullClient=await approved();assert.equal((await exchange(fullClient,randomBytes(32).toString("base64url"))).status,400);assert.equal((await exchange(fullClient,fullClient.verifier,"https://evil.example/mcp")).status,400);
      const token=await exchange(fullClient);assert.equal(token.status,200);full=await token.json();assert.equal(full.token_type,"Bearer");assert.ok(full.expires_in<=900);assert.equal((await exchange(fullClient)).status,400);
      readClient=await approved("temco.read offline_access");const response=await exchange(readClient);assert.equal(response.status,200);read=await response.json();
      const devices=await(await request(`/api/admin/users/${owner.id}/devices`,{cookie:browser})).json();assert.equal(devices.devices.filter((item:any)=>item.kind==="mcp").length,2);assert.ok(!JSON.stringify(devices).includes(full.access_token));
    });
    await t.test("confidential DCR clients authenticate and revocation ends only their device",async()=>{
      const item=await approved("temco.read offline_access",browser,"client_secret_post"),response=await exchange(item);assert.equal(response.status,200);const tokens=await response.json();
      const denied=await request("/oauth/token",{form:new URLSearchParams({grant_type:"refresh_token",client_id:item.client.client_id,client_secret:"synthetic-wrong-secret",refresh_token:tokens.refresh_token,resource:base+"/mcp"})});assert.equal(denied.status,401);
      const revoked=await request("/oauth/revoke",{form:new URLSearchParams({client_id:item.client.client_id,client_secret:item.client.client_secret,token:tokens.access_token})});assert.equal(revoked.status,200);assert.equal((await request("/mcp",{token:tokens.access_token,body:{jsonrpc:"2.0",id:5,method:"tools/list"}})).status,401);
    });
    await t.test("modern MCP discovery, role checks, read-only denial and retained convenience tools",async()=>{
      const modernFull=modern(full.access_token);modernClient=modernFull.client;await modernClient.connect(modernFull.transport);const listed=await modernClient.listTools();assert.ok(listed.tools.some(tool=>tool.name==="application_action"));assert.deepEqual(listed.tools.find(tool=>tool.name==="application_read")?._meta?.securitySchemes,[{type:"oauth2",scopes:["temco.read"]}]);assert.deepEqual(listed.tools.find(tool=>tool.name==="application_action")?._meta?.securitySchemes,[{type:"oauth2",scopes:["temco.read","temco.write"]}]);
      const actions=body(await modernClient.callTool({name:"application_actions",arguments:{}}));assert.ok(actions.actions.length>=85);
      const readOnly=modern(read.access_token);await readOnly.client.connect(readOnly.transport);const readActions=body(await readOnly.client.callTool({name:"application_actions",arguments:{}}));assert.ok(!readActions.actions.some((action:any)=>action.mode==="write"));
      const denied=await readOnly.client.callTool({name:"application_action",arguments:{action:"users.create",input:{body:{username:prefix+"forbidden",displayName:"Forbidden"}},operationId:randomUUID()}});assert.ok(denied.isError);assert.ok(denied._meta?.["mcp/www_authenticate"]);
      const confusable=await readOnly.client.callTool({name:"application_read",arguments:{action:"relays.status",input:{params:{action:"request"},body:{}}}});assert.ok(confusable.isError);
      body(await modernClient.callTool({name:"mars_workflow_summary",arguments:{}}));
    });
    await t.test("write receipts prevent repeat dispatch and conflicting reuse; native actor attribution",async()=>{
      const operationId=randomUUID(),input={body:{username:prefix+"created",displayName:"Created over MCP",role:"user"}};
      const first=body(await modernClient.callTool({name:"application_action",arguments:{action:"users.create",input,operationId}}));assert.equal(first.httpStatus,200);
      const replay=body(await modernClient.callTool({name:"application_action",arguments:{action:"users.create",input,operationId}}));assert.equal(first.result.id,replay.result.id);
      const conflict=await modernClient.callTool({name:"application_action",arguments:{action:"users.create",input:{body:{username:prefix+"other",displayName:"Other"}},operationId}});assert.ok(conflict.isError);
      assert.equal(await prisma.user.count({where:{username:prefix+"created"}}),1);
      const saved=await prisma.mcpOperation.findFirstOrThrow({where:{operationId}});assert.equal(saved.state,"completed");
      const detail=body(await modernClient.callTool({name:"application_read",arguments:{action:"mcp.operation",input:{operationId}}}));assert.equal(detail.state,"completed");
    });
    await t.test("native multipart imports, scanning, exports, report engine and barcode artifacts",async()=>{
      const workbook=new ExcelJS.Workbook();workbook.addWorksheet("Pick").addRows([["Route","LPN"],["MCP-R1","MCP-LPN-1"]]);const dataBase64=Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
      const preview=body(await modernClient.callTool({name:"application_read",arguments:{action:"pick_waves.preview",input:{files:[{field:"file",filename:"synthetic.xlsx",contentType:"application/octet-stream",dataBase64}]}}}));assert.equal(preview.httpStatus,200);assert.equal(preview.result.preview.itemCount,1);
      const wave=body(await modernClient.callTool({name:"application_action",arguments:{action:"pick_waves.create",operationId:randomUUID(),input:{files:[{field:"file",filename:"synthetic.xlsx",contentType:"application/octet-stream",dataBase64}],form:{name:prefix+"wave",routeMappings:JSON.stringify([{routeNumber:"MCP-R1",stagingLocation:null}])}}}}));assert.equal(wave.httpStatus,200);
      const scanned=body(await modernClient.callTool({name:"application_action",arguments:{action:"pick_waves.scan",operationId:randomUUID(),input:{params:{id:wave.result.pickWave.id},body:{scannedValue:"MCP-LPN-1"}}}}));assert.equal(scanned.httpStatus,200);
      const record=await prisma.pickWave.findUniqueOrThrow({where:{id:wave.result.pickWave.id}});assert.equal(record.createdByUserId,owner.id);
      const report=body(await modernClient.callTool({name:"application_read",arguments:{action:"reports.execute",input:{rows:[{item:"B",qty:2},{item:"A",qty:1}],steps:[{type:"sort",column:"item",direction:"asc"}]}}}));assert.equal(report.value[0].item,"A");
      const invalid=await modernClient.callTool({name:"application_read",arguments:{action:"reports.execute",input:{rows:[],steps:[{type:"unknown"}]}}});assert.ok(invalid.isError);
      const legacyBook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(legacyBook,XLSX.utils.json_to_sheet([{LPN:"legacy-1",Quantity:2}]),"Legacy");
      const parsed=body(await modernClient.callTool({name:"application_read",arguments:{action:"spreadsheets.parse",input:{file:{filename:"legacy.xls",dataBase64:Buffer.from(XLSX.write(legacyBook,{type:"buffer",bookType:"biff8"})).toString("base64")}}}}));assert.equal(parsed.rows[0].LPN,"legacy-1");
      const exported=body(await modernClient.callTool({name:"application_read",arguments:{action:"reports.export",input:{rows:report.value}}}));const exportedFile=body(await modernClient.callTool({name:"application_read",arguments:{action:"mcp.artifact",input:{id:exported.download.id}}}));const exportedBook=XLSX.read(Buffer.from(exportedFile.dataBase64,"base64"));assert.equal(XLSX.utils.sheet_to_json<any>(exportedBook.Sheets.Report)[0].item,"A");
      const barcode=body(await modernClient.callTool({name:"application_read",arguments:{action:"barcodes.generate",input:{values:["MCP-LPN-1"]}}}));assert.ok(barcode.download.uri.startsWith("temco://"));
      const file=body(await modernClient.callTool({name:"application_read",arguments:{action:"mcp.artifact",input:{id:barcode.download.id,offset:0,length:49152}}}));assert.ok(Buffer.from(file.dataBase64,"base64").toString().includes("<svg"));
      const foreign=modern(read.access_token);await foreign.client.connect(foreign.transport);const denied=await foreign.client.callTool({name:"application_read",arguments:{action:"mcp.artifact",input:{id:barcode.download.id}}});assert.ok(denied.isError);
      assert.equal((await request(new URL(barcode.download.url).pathname,{cookie:browser})).status,200);assert.equal((await request(new URL(barcode.download.url).pathname,{cookie:staffCookie})).status,401);
    });
    await t.test("MCP printing uses the real app's device authorization and existing browser relay",async()=>{
      const printer=await prisma.labelPrinter.create({data:{name:prefix+"printer",endpoint:"http://synthetic-printer.invalid:9100",contentType:"text/plain",createdByUserId:owner.id,updatedByUserId:owner.id}});
      const broker=createRelayServer({origin:base!,heartbeatInterval:60000,authenticate:async(cookie:string,authorization:string)=>{const response=await fetch(base+"/api/label-relay/session",{headers:{Cookie:cookie,...(authorization?{Authorization:authorization}:{})}});return response.ok?response.json():null;}});
      broker.server.listen(33026,"127.0.0.1");await once(broker.server,"listening");
      const receiver=new WebSocket("ws://127.0.0.1:33026/api/label-relay/ws",{origin:base!,headers:{Cookie:browser}}),messages:any[]=[],waiters:{type:string;resolve:(value:any)=>void}[]=[];
      receiver.on("message",raw=>{const value=JSON.parse(raw.toString()),index=waiters.findIndex(waiter=>waiter.type===value.type);if(index>=0)waiters.splice(index,1)[0].resolve(value);else messages.push(value);});
      const next=(type:string)=>new Promise<any>((resolve,reject)=>{const index=messages.findIndex(value=>value.type===type);if(index>=0){resolve(messages.splice(index,1)[0]);return;}const timer=setTimeout(()=>reject(new Error("Missing synthetic relay message")),5000);waiters.push({type,resolve:value=>{clearTimeout(timer);resolve(value);}});});
      try {
        await next("hello");receiver.send(JSON.stringify({type:"register",name:"Synthetic receiver",printerIds:[printer.id]}));await next("registered");
        assert.equal((await request("/api/label-relay/session",{token:read.access_token})).status,403);
        const args={action:"labels.print",operationId:randomUUID(),input:{printerId:printer.id,zpl:"^XA^FDSynthetic^FS^XZ"}},printing=modernClient.callTool({name:"application_action",arguments:args});
        const job=await next("job");assert.equal(job.printer.id,printer.id);assert.equal(job.zpl,args.input.zpl);receiver.send(JSON.stringify({type:"result",jobId:job.jobId,ok:true}));assert.equal(body(await printing).ok,true);
        assert.equal(body(await modernClient.callTool({name:"application_action",arguments:args})).ok,true);assert.equal(messages.some(value=>value.type==="job"),false);
      } finally {receiver.terminate();await broker.close();await prisma.labelPrinter.delete({where:{id:printer.id}});}
    });
    await t.test("legacy SDK uses the same OAuth bearer endpoint",async()=>{
      const legacy=new LegacyClient({name:"synthetic-legacy",version:"1"});clients.push(legacy);await legacy.connect(new LegacyTransport(new URL(base+"/mcp"),{requestInit:{headers:{Authorization:`Bearer ${full.access_token}`}}}));const tools=await legacy.listTools();assert.ok(tools.tools.some(tool=>tool.name==="application_actions"));assert.ok(!body(await legacy.callTool({name:"application_read",arguments:{action:"account.current",input:{}}})).access_token);
    });
    await t.test("browser logout leaves separately authorized MCP devices; admin edits need no timed password",async()=>{
      await prisma.authSession.updateMany({where:{userId:owner.id,kind:"password"},data:{reauthenticatedAt:new Date(0)}});
      const edit=await fetch(base+`/api/admin/users/${staff.id}`,{method:"PATCH",headers:{Cookie:browser,Origin:base!,"Content-Type":"application/json"},body:JSON.stringify({expectedAuthVersion:staff.authVersion,displayName:"Updated without timer"})});assert.equal(edit.status,200);
      assert.equal((await request("/api/auth/logout",{cookie:browser,body:{}})).status,200);body(await modernClient.callTool({name:"application_read",arguments:{action:"account.current",input:{}}}));browser=await login(owner.username);
    });
    await t.test("refresh rotation/replay, individual device revocation and current administrator status",async()=>{
      const refresh=new URLSearchParams({grant_type:"refresh_token",client_id:readClient.client.client_id,refresh_token:read.refresh_token,resource:base+"/mcp"});const response=await request("/oauth/token",{form:refresh});assert.equal(response.status,200);const next:Tokens=await response.json();
      assert.equal((await request("/oauth/token",{form:refresh})).status,400);const revoked=await request("/mcp",{token:next.access_token,body:{jsonrpc:"2.0",id:100,method:"tools/list"}});assert.equal(revoked.status,401);
      const sessions=await(await request(`/api/admin/users/${owner.id}/devices`,{cookie:browser})).json();const activeMcp=sessions.devices.find((device:any)=>device.kind==="mcp");assert.ok(activeMcp);
      const revoke=await request(`/api/admin/users/${owner.id}/devices`,{cookie:browser,method:"DELETE",body:{sessionId:activeMcp.id}});assert.equal(revoke.status,200);
      assert.equal((await request("/mcp",{token:full.access_token,body:{jsonrpc:"2.0",id:101,method:"tools/list"}})).status,401);assert.equal((await request("/api/admin/users",{cookie:browser})).status,200);
      const replacement=await approved(),tokens=await(await exchange(replacement)).json();await prisma.user.update({where:{id:owner.id},data:{role:"manager"}});assert.equal((await request("/mcp",{token:tokens.access_token,body:{jsonrpc:"2.0",id:102,method:"tools/list"}})).status,401);await prisma.user.update({where:{id:owner.id},data:{role:"admin"}});
      const wrongOwner=await request(`/api/admin/users/${staff.id}/devices`,{cookie:browser,method:"DELETE",body:{sessionId:activeMcp.id}});assert.equal(wrongOwner.status,404);
      const allDevice=await approved(),allTokens=await(await exchange(allDevice)).json();const currentUser=await prisma.user.findUniqueOrThrow({where:{id:owner.id}});
      const allOut=await request(`/api/admin/users/${owner.id}`,{cookie:browser,method:"PATCH",body:{expectedAuthVersion:currentUser.authVersion,revokeSessions:true}});assert.equal(allOut.status,200);
      assert.equal((await request("/mcp",{token:allTokens.access_token,body:{jsonrpc:"2.0",id:103,method:"tools/list"}})).status,401);assert.equal((await request("/api/admin/users",{cookie:browser})).status,401);
    });
  } finally {
    for(const client of clients)await client.close().catch(()=>undefined);
    await prisma.pickWave.deleteMany({where:{createdByUserId:owner.id}});
    const users=await prisma.user.findMany({where:{username:{startsWith:prefix}},select:{id:true}});const ids=users.map(user=>user.id);
    await prisma.authSession.deleteMany({where:{userId:{in:ids}}});await prisma.mcpAuthorization.deleteMany({where:{userId:{in:ids}}});await prisma.user.deleteMany({where:{id:{in:ids}}});await prisma.$disconnect();
  }
});
