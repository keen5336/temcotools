import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CAPABILITIES, type Principal } from "../lib/auth/principal";

const testUrl=process.env.PHYSICAL_STOCK_TEST_DATABASE_URL;
test("Inventory Audit shared physical view uses native corrected evidence with bounded honest continuation",{skip:!testUrl},async t=>{
  const target=new URL(testUrl!);
  assert.equal(target.protocol,"postgresql:");assert.equal(target.hostname,"127.0.0.1");assert.equal(target.port,"55439");assert.equal(target.pathname,"/temcotools_v2_physical_stock_test");assert.equal(target.search,"");
  process.env.DATABASE_URL=testUrl;
  const {prisma}=await import("../lib/db"),stock=await import("../lib/warehouse/physical-stock"),units=await import("../lib/warehouse/units");
  const {createAccessGrant,authenticateAccessGrant,revokeAccessGrant}=await import("../lib/application/grants");
  const {executeApplicationAction,listApplicationActions}=await import("../lib/application/actions");
  const prefix=`physical-${randomUUID()}`,now=Date.now(),day=86_400_000;
  const bundle=await prisma.roleBundle.create({data:{name:prefix,capabilities:[...CAPABILITIES]}});
  const user=await prisma.user.create({data:{username:prefix,displayName:"Synthetic physical-view operator",pinHash:"disabled:synthetic",role:"admin",roleBundles:{create:{bundleId:bundle.id}}}});
  const session=await prisma.userSession.create({data:{id:randomUUID(),userId:user.id,authVersion:user.authVersion,deviceLabel:"Synthetic physical view",expiresAt:new Date(now+3_600_000),mfaVerifiedAt:new Date()}});
  const actor:Principal={userId:user.id,username:user.username,displayName:user.displayName,role:user.role,authVersion:user.authVersion,sessionId:session.id,capabilities:[...CAPABILITIES],strongAuthenticatedAt:now,mfaVerifiedAt:now};
  const ids:string[]=[];let batchId:string|undefined;
  async function unit(name:string){const id=`${prefix}-${name}`;ids.push(id);return prisma.warehouseUnit.create({data:{id,creationEvidence:"Synthetic exact-unit identity. Order context never merges units."}});}
  async function observed(unitId:string,type="presence",at=now-60_000,location:string|null="SYNTHETIC LANE 1"){
    return prisma.warehousePhysicalObservation.create({data:{id:randomUUID(),unitId,userId:user.id,eventId:randomUUID(),fingerprint:"synthetic-view-fixture",rawIdentifier:unitId,identifierType:"lpn",type,capturedAt:new Date(at),location,captureMethod:"manual",resolution:"resolved",candidateUnitIds:[unitId]}});
  }
  async function source(unitId:string,name:string,status="Delivered"){
    return prisma.inventoryAuditItem.create({data:{unitId,lpn:`${prefix}-${name}`,status,orderNumber:`${prefix}-SAME-ORDER`,vendor:"Synthetic vendor",receivedDate:"2026-01-01",description:"Synthetic appliance",customerName:"Synthetic fixture",sourceData:{synthetic:"only"},contentHash:randomUUID(),verifiedAt:new Date(now-day),archivedAt:new Date(now-day)}});
  }
  async function one(unitId:string){const result=await stock.getPhysicalStock(actor,{view:"all",search:unitId});assert.equal(result.items.length,1);return result.items[0];}
  try{
    await t.test("reported/historical/Pick-Wave-verified rows cannot establish stock, while manual units can",async()=>{
      const reported=await unit("reported"),manual=await unit("manual"),original=await unit("original-A"),replacement=await unit("replacement-B");
      const rows=await Promise.all([source(reported.id,"REPORTED"),source(original.id,"ORIGINAL"),source(replacement.id,"REPLACEMENT")]);
      await observed(manual.id);await observed(original.id,"presence",now-30_000);await observed(replacement.id,"departure",now-20_000);
      const physical=await stock.getPhysicalStock(actor,{view:"present",search:prefix});assert.deepEqual(new Set(physical.items.map(row=>row.unitId)),new Set([manual.id,original.id]));
      assert.equal((await one(reported.id)).state,"unobserved");assert.equal((await one(replacement.id)).state,"departed");assert.equal((await one(manual.id)).sourceRowCount,0);
      const byOrder=await stock.getPhysicalStock(actor,{view:"all",search:`${prefix}-SAME-ORDER`});assert.equal(byOrder.items.length,3);assert.ok(byOrder.items.some(row=>row.unitId===original.id&&row.state==="present"));assert.ok(byOrder.items.some(row=>row.unitId===replacement.id&&row.state==="departed"));
      assert.deepEqual(await prisma.inventoryAuditItem.findMany({where:{id:{in:rows.map(row=>row.id)}},orderBy:{id:"asc"}}),rows.sort((a,b)=>a.id.localeCompare(b.id)),"Reading physical evidence does not update reported status, archive or legacy verifiedAt.");
    });
    await t.test("every equal-time conflict is retained and repeated scans never multiply physical units",async()=>{
      const duplicate=await unit("duplicates"),conflict=await unit("conflict"),typeConflict=await unit("type-conflict"),at=now-5000;
      await Promise.all([observed(duplicate.id,"placement",at,"SYNTHETIC LANE 2"),observed(duplicate.id,"placement",at,"SYNTHETIC LANE 2")]);
      await prisma.warehousePhysicalObservation.createMany({data:Array.from({length:120},(_,index)=>({id:randomUUID(),unitId:conflict.id,userId:user.id,eventId:randomUUID(),fingerprint:"synthetic-tied-fixture",rawIdentifier:conflict.id,identifierType:"lpn",type:"presence",capturedAt:new Date(at),location:index===49?"SYNTHETIC LANE 4":"SYNTHETIC LANE 3",captureMethod:"manual",resolution:"resolved",candidateUnitIds:[conflict.id]}))});
      await observed(typeConflict.id,"departure",at);await observed(typeConflict.id,"check_in",at);
      const duplicateRow=await one(duplicate.id);assert.equal(duplicateRow.state,"present");assert.equal(duplicateRow.latestTieCount,2);assert.equal(duplicateRow.observationCount,2);
      const row=await one(conflict.id);assert.equal(row.state,"conflicts");assert.equal(row.latestTieCount,120);assert.equal(row.observationCount,120);
      const types=await one(typeConflict.id);assert.equal(types.state,"conflicts");assert.equal(types.currentStayCheckInAt,null,"A simultaneous check-in is not strictly after departure.");
      const present=await stock.getPhysicalStock(actor,{view:"present",search:duplicate.id,location:"SYNTHETIC LANE 2"});assert.equal(present.items.length,1);
      assert.equal((await stock.getPhysicalStock(actor,{view:"present",search:duplicate.id,location:"SYNTHETIC LANE 3"})).items.length,0);
      const threeLanes=await unit("three-latest-lanes");
      for(const location of ["SYNTHETIC TIE A","SYNTHETIC TIE B","SYNTHETIC TIE C"])await observed(threeLanes.id,"placement",at,location);
      for(const location of ["SYNTHETIC TIE A","SYNTHETIC TIE B","SYNTHETIC TIE C"]){
        const filtered=await stock.getPhysicalStock(actor,{view:"conflicts",search:threeLanes.id,location});
        assert.equal(filtered.items.length,1,"Every latest tied location must expose the conflict, including a location outside the bounded representative facts.");
        assert.equal(filtered.items[0].state,"conflicts");assert.equal(filtered.items[0].matchedLocationFilter,location);
      }
      assert.equal((await stock.getPhysicalStock(actor,{view:"present",search:threeLanes.id,location:"SYNTHETIC TIE A"})).items.length,0,"Conflicting lane evidence never becomes confident present stock.");
    });
    await t.test("current-stay check-in survives long history and means the first check-in strictly after latest departure",async()=>{
      const item=await unit("long-history"),departure=now-3*day,checkin=now-2*day;
      await prisma.warehousePhysicalObservation.createMany({data:Array.from({length:240},(_,index)=>({id:randomUUID(),unitId:item.id,userId:user.id,eventId:randomUUID(),fingerprint:"synthetic-old-history",rawIdentifier:item.id,identifierType:"lpn",type:index%2?"presence":"check_in",capturedAt:new Date(now-10*day+index*1000),location:"SYNTHETIC OLD LANE",captureMethod:"scanner",resolution:"resolved",candidateUnitIds:[item.id]}))});
      await observed(item.id,"departure",departure,null);await observed(item.id,"check_in",checkin);await observed(item.id,"check_in",now-day);const last=await observed(item.id,"presence",now-1000);
      const row=await one(item.id);assert.equal(row.state,"present");assert.equal(row.observationCount,244);assert.equal(row.latestObservation?.id,last.id);assert.equal(row.lastDepartureAt,new Date(departure).toISOString());assert.equal(row.currentStayCheckInAt,new Date(checkin).toISOString());
      assert.ok(row.observationAgeSeconds!==null&&row.observationAgeSeconds<20,"Sighting age is not residence age.");
    });
    await t.test("only explicit corrections move/retract observation identity; revoked aliases preserve the original fact",async()=>{
      const a=await unit("correction-A"),b=await unit("correction-B");
      const alias=await units.linkWarehouseIdentifier(actor,{unitId:a.id,kind:"lpn",value:`${prefix}-OLD-ALIAS`,evidence:"Synthetic original label reviewed against exact appliance."});
      const captured=await units.recordWarehouseObservation(actor,{eventId:randomUUID(),rawIdentifier:alias.value,identifierType:"lpn",type:"presence",capturedAt:new Date(now-5000).toISOString(),captureMethod:"scanner"});
      await units.unlinkWarehouseIdentifier(actor,{identifierId:alias.identifierId,reason:"Synthetic stale label revoked; this is not a physical observation correction."});
      const historical=await stock.getPhysicalStock(actor,{view:"present",search:alias.value});assert.equal(historical.items[0].unitId,a.id);assert.equal(historical.items[0].historicalAliasMatch,true);assert.equal(historical.items[0].historicalAliasCount,1);
      await units.correctWarehouseObservation(actor,{operationId:randomUUID(),observationId:captured.observation.observationId,unitId:null,reason:"Synthetic reviewed photograph cannot identify the unit.",expectedRevision:0});
      const detached=await one(a.id);assert.equal(detached.state,"unobserved");assert.equal(detached.withdrawnAssociationCount,1);
      await units.correctWarehouseObservation(actor,{operationId:randomUUID(),observationId:captured.observation.observationId,unitId:b.id,reason:"Synthetic new exact-unit evidence identifies appliance B.",expectedRevision:1});
      const corrected=await one(b.id);assert.equal(corrected.state,"present");assert.equal(corrected.latestObservation?.originalUnitId,a.id);assert.equal(corrected.latestObservation?.correctionRevision,2);assert.equal(corrected.correctedObservationCount,1);assert.equal((await one(a.id)).state,"unobserved");
      const accepted=await prisma.warehousePhysicalObservation.findUniqueOrThrow({where:{id:captured.observation.observationId}});const correction=await prisma.warehouseObservationCorrection.findFirstOrThrow({where:{observationId:accepted.id},orderBy:{revision:"asc"}});
      if(correction.createdAt>accepted.receivedAt){const prior=await stock.getPhysicalStock(actor,{view:"all",search:a.id,asOf:new Date(correction.createdAt.getTime()-1).toISOString()});assert.equal(prior.items[0].state,"present","asOf honors correction acceptance, not later correction state.");}
    });
    await t.test("reported-row source times and bounded aliases are explicit, including unknown legacy source-as-of",async()=>{
      const item=await unit("summaries");await observed(item.id);const rows=[];
      for(let index=0;index<5;index++)rows.push(await source(item.id,`SUMMARY-${index}`,index===4?"=SYNTHETIC-FORMULA":"Placing"));
      for(let index=0;index<8;index++)await units.linkWarehouseIdentifier(actor,{unitId:item.id,kind:"msn",value:`${prefix}-SUMMARY-MSN-${index}`,evidence:"Synthetic exact-unit cross-system identifier evidence."});
      const batch=await prisma.inventoryAuditImport.create({data:{filename:"synthetic-physical-view.xlsx",uploadedByName:user.displayName,rowCount:1,insertedCount:0,changedCount:0,unchangedCount:1,duplicateCount:0,blankCount:0,scope:"synthetic warehouse",coverage:"partial",sourceAsOf:new Date(now-day)}});batchId=batch.id;
      const row=rows[4];const revision=await prisma.inventorySourceRevision.create({data:{inventoryItemId:row.id,revision:1,contentHash:"synthetic",sourceData:{synthetic:"only"},lpn:row.lpn,status:row.status,receivedDate:row.receivedDate,orderNumber:row.orderNumber,vendor:row.vendor,description:row.description,customerName:row.customerName}});
      await prisma.inventoryAuditItem.updateMany({where:{id:{in:rows.slice(0,4).map(item=>item.id)}},data:{sourceChangedAt:new Date(now-day)}});
      await prisma.inventoryImportMembership.create({data:{importId:batch.id,sourceRevisionId:revision.id,lpn:row.lpn}});
      const summary=await one(item.id);assert.equal(summary.sourceRowCount,5);assert.equal(summary.sourceRows.length,3);assert.equal(summary.sourceRowsMayBeTruncated,true);assert.equal(summary.aliasCount,8);assert.equal(summary.aliases.length,5);assert.equal(summary.aliasesMayBeTruncated,true);
      const reported=summary.sourceRows.find(source=>source.lpn===row.lpn)!;assert.equal(reported.sourceAsOf,new Date(now-day).toISOString());assert.equal(reported.coverage,"partial");assert.ok(summary.sourceRows.some(source=>source.sourceAsOf===null));
      const csv=await stock.exportPhysicalStock(actor,{view:"all",search:item.id});assert.match(csv.csv,/'=SYNTHETIC-FORMULA/);assert.match(csv.csv,/Source Rows Truncated/);assert.match(csv.csv,/page_metadata/);
    });
    await t.test("sparse filtered pages and export parts continue without false empty-stock claims or duplicate units",async()=>{
      const sparse=[];for(let index=0;index<8;index++)sparse.push(await unit(`sparse-${index.toString().padStart(2,"0")}`));await observed(sparse[5].id);await observed(sparse[7].id);
      const first=await stock.getPhysicalStock(actor,{search:`${prefix}-sparse`,view:"present",scanLimit:2,limit:1});assert.equal(first.items.length,0);assert.equal(first.examinedUnits,2);assert.equal(first.hasMore,true);assert.equal(first.searchWindowComplete,false);assert.equal(first.nextCursor,sparse[1].id);
      const emptyExport=await stock.exportPhysicalStock(actor,{search:`${prefix}-sparse`,view:"present",scanLimit:2,limit:1});assert.equal(emptyExport.rowCount,0);assert.equal(emptyExport.hasMore,true);assert.match(emptyExport.csv,/page_metadata/);assert.ok(emptyExport.csv.includes(sparse[1].id));assert.match(emptyExport.csv,/not a signed warehouse snapshot/);
      const found=new Set<string>();let cursor:string|undefined;let pages=0;
      do{const page=await stock.getPhysicalStock(actor,{search:`${prefix}-sparse`,view:"present",scanLimit:2,limit:1,cursor,asOf:first.asOf});pages++;assert.ok(pages<10);for(const row of page.items){assert.equal(found.has(row.unitId),false);found.add(row.unitId);}cursor=page.nextCursor??undefined;}while(cursor);
      assert.deepEqual(found,new Set([sparse[5].id,sparse[7].id]));
      const part=await stock.exportPhysicalStock(actor,{search:`${prefix}-sparse`,view:"all",scanLimit:8,limit:1});assert.equal(part.rowCount,1);assert.equal(part.hasMore,true);assert.equal(part.nextCursor,sparse[0].id);
      await assert.rejects(stock.getPhysicalStock(actor,{limit:101}));await assert.rejects(stock.exportPhysicalStock(actor,{limit:1001}));await assert.rejects(stock.getPhysicalStock(actor,{asOf:new Date(Date.now()+60_000).toISOString()}),/future/);
    });
    await t.test("UI/MCP share discoverable input contracts and current scoped/revoked authority",async()=>{
      const created=await createAccessGrant(actor,{clientName:"Synthetic read-only physical view",scopes:["inventory.read"],lifetimeMinutes:5});const client=await authenticateAccessGrant(created.token);
      const discovered=listApplicationActions(client,{prefix:"warehouse.physical-stock",includeSchemas:true});assert.equal(discovered.length,2);assert.ok(discovered.every(action=>"inputSchema" in action));
      const output=await executeApplicationAction(client,"warehouse.physical-stock",{search:prefix,view:"all",limit:2}) as {items:unknown[]};assert.equal(output.items.length,2);
      await assert.rejects(stock.getPhysicalStock({...client,capabilities:[]},{search:prefix}),/permission/i);
      await revokeAccessGrant(actor,created.grant.id);await assert.rejects(stock.getPhysicalStock(client,{search:prefix}),/revoked/);
      await prisma.roleBundle.update({where:{id:bundle.id},data:{capabilities:CAPABILITIES.filter(cap=>cap!=="inventory.read")}});await assert.rejects(stock.getPhysicalStock(actor,{search:prefix}),/permission/i);
      await prisma.roleBundle.update({where:{id:bundle.id},data:{capabilities:[...CAPABILITIES]}});
      await prisma.userSession.update({where:{id:session.id},data:{lockedAt:new Date()}});await assert.rejects(stock.getPhysicalStock(actor,{search:prefix}),/locked/);
    });
  }finally{
    const sourceRows=await prisma.inventoryAuditItem.findMany({where:{unitId:{in:ids}},select:{id:true}});
    await prisma.inventoryImportMembership.deleteMany({where:{sourceRevision:{inventoryItemId:{in:sourceRows.map(row=>row.id)}}}});await prisma.inventorySourceRevision.deleteMany({where:{inventoryItemId:{in:sourceRows.map(row=>row.id)}}});await prisma.inventoryAuditItem.deleteMany({where:{id:{in:sourceRows.map(row=>row.id)}}});if(batchId)await prisma.inventoryAuditImport.delete({where:{id:batchId}});
    await prisma.warehouseObservationCorrection.deleteMany({where:{userId:user.id}});await prisma.warehousePhysicalObservation.deleteMany({where:{userId:user.id}});await prisma.warehouseIdentifier.deleteMany({where:{unitId:{in:ids}}});await prisma.warehouseUnit.deleteMany({where:{id:{in:ids}}});
    await prisma.appAccessGrant.deleteMany({where:{userId:user.id}});await prisma.identityAudit.deleteMany({where:{actorUserId:user.id}});await prisma.userSession.delete({where:{id:session.id}});await prisma.userRoleBundle.deleteMany({where:{userId:user.id}});await prisma.user.delete({where:{id:user.id}});await prisma.roleBundle.delete({where:{id:bundle.id}});await prisma.$disconnect();
  }
});
