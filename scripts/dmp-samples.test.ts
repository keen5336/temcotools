import assert from "node:assert/strict";
import test from "node:test";
import { inspectSampleBody, MAX_SAMPLE_BYTES } from "../lib/dmp-samples/structure";
import { inspectRoutePlannerContext } from "../lib/dmp-samples/route-context";

test("body-only XML preserves every sequence/attribute occurrence without inventing route or appliance mappings", () => {
  const xml = '<?xml version="1.0"?><Output Type="listRouteDetail1"><parmDocRouteDetail><DocRouteDetail RouteID="SYNTHETIC-R1"><FWOrderLine OrderID="SYNTHETIC-SAME" Sequence="1" Location="SYNTHETIC-5288" Type="66" Qty="1"/><FWOrderLine OrderID="SYNTHETIC-SAME" Sequence="2" Location="SYNTHETIC-CUSTOMER" Type="67" Qty="1"/><FWOrderLine OrderID="SYNTHETIC-SAME" Sequence="3" Location="SYNTHETIC-OTHER-STORE" Type="66" Qty="2"/></DocRouteDetail></parmDocRouteDetail></Output>';
  const result = inspectSampleBody("xml", xml);
  assert.equal("values" in result, false); assert.equal(JSON.stringify(result).includes("SYNTHETIC-5288"), false);
  const prefix = "/Output/parmDocRouteDetail/DocRouteDetail/FWOrderLine";
  const orders = result.structure.fields.find(field => field.path === `${prefix}/@OrderID`)!;
  assert.equal(orders.occurrences, 3); assert.equal(orders.distinctValues, 1, "Repeated order IDs retain separate line occurrences.");
  const values = inspectSampleBody("xml", xml, { fieldPath: `${prefix}/@Location`, limit: 2 });
  assert.deepEqual(values.values?.items.map(item => item.value), ["SYNTHETIC-5288", "SYNTHETIC-CUSTOMER"]);
  assert.deepEqual(values.values?.items.map(item => item.occurrence), [0, 1]); assert.equal(values.values?.nextOffset, 2);
  assert.equal(values.values?.items[1].sourcePath, "/Output[0]/parmDocRouteDetail[0]/DocRouteDetail[0]/FWOrderLine[1]/@Location");
  const third = inspectSampleBody("xml", xml, { fieldPath: `${prefix}/@Location`, offset: 2, limit: 2 }); assert.equal(third.values?.items[0].value, "SYNTHETIC-OTHER-STORE"); assert.equal(third.values?.nextOffset, null);
  assert.match(result.structure.limitations, /no identifier mapping, all-day coverage/);
});

test("JSON and quoted CSV expose only structure until explicit bounded values are requested", () => {
  const body = JSON.stringify({ deliveries: [{ order: "SYNTHETIC-A", quantity: 2, active: true }, { order: "SYNTHETIC-B", quantity: null, active: false }] });
  const structure = inspectSampleBody("json", body); assert.equal(JSON.stringify(structure).includes("SYNTHETIC-A"), false);
  assert.deepEqual(structure.structure.fields.find(field => field.path === "/deliveries/*/quantity")?.types, ["null", "number"]);
  assert.deepEqual(inspectSampleBody("json", body, { fieldPath: "/deliveries/*/order", limit: 1 }).values?.items.map(item => item.value), ["SYNTHETIC-A"]);
  const csv = 'Order,Description,Quantity\r\nSYNTHETIC-A,"A, B\nC",02\r\nSYNTHETIC-A,"A ""quoted"" unit",1\r\n';
  assert.equal(inspectSampleBody("csv", csv).structure.rows, 2);
  assert.equal(inspectSampleBody("csv", csv, { fieldPath: "/rows/*/Description" }).values?.items[0].value, "A, B\nC");
  assert.equal(inspectSampleBody("csv", csv, { fieldPath: "/rows/*/Quantity" }).values?.items[0].value, "02", "No coercion removes identifier/quantity text precision.");
  assert.equal(inspectSampleBody("json", JSON.stringify({ description: "x".repeat(300) }), { fieldPath: "/description" }).values?.items[0].truncated, true);
});

test("rejects XML expansion, links, secrets/HAR/wrappers, malformed input and excessive parsing/output", () => {
  const invalid: Array<["json" | "csv" | "xml", string]> = [
    ["xml", '<!DOCTYPE root [<!ENTITY x "boom">]><root>&x;</root>'], ["xml", '<root><x></root>'], ["xml", '<root href="https://synthetic-user:synthetic-password@invalid.example"/>'], ["xml", '<?unsafe code?><root/>'], ["xml", '<root><Cookie>secret</Cookie></root>'],
    ["json", '{"log":{"entries":[{"request":{"headers":[]}}]}}'], ["json", '{"log":{"entries":[]}}'], ["json", '{"token":"synthetic"}'], ["json", '{"x-api-key":"synthetic"}'], ["json", '{"data":"Bearer synthetic-credential-token"}'], ["json", '{"__proto__":{"x":1}}'], ["csv", "Order,Cookie\nsynthetic,credential"], ["csv", 'Order,Q\na,"unclosed'], ["csv", "Order,Order\na,b"], ["csv", "Order,Q\na,b,c"],
  ];
  for (const [format, body] of invalid) assert.throws(() => inspectSampleBody(format, body));
  assert.throws(() => inspectSampleBody("json", '{"x":"' + "a".repeat(MAX_SAMPLE_BYTES) + '"}'), /2 MiB/);
  assert.throws(() => inspectSampleBody("json", "[".repeat(26) + "0" + "]".repeat(26)), /nesting/);
  assert.throws(() => inspectSampleBody("xml", "<x>".repeat(25) + "v" + "</x>".repeat(25)), /nesting/);
  assert.throws(() => inspectSampleBody("json", JSON.stringify(Array.from({ length: 10_001 }, () => 1))), /10,000/);
  assert.throws(() => inspectSampleBody("json", '{"x":1}', { fieldPath: "/x", limit: 21 }), /bounded/);
  assert.throws(() => inspectSampleBody("json", '{"x":1}', { fieldPath: "/missing" }), /exact field/);
  for (const [format, body] of [["xml", '<Output stKn="SYNTHETIC-CREDENTIAL"/>'], ["json", '{"StKn":"SYNTHETIC-CREDENTIAL"}'], ["csv", "STKN=SYNTHETIC-CREDENTIAL"], ["xml", "<Output>STKN: SYNTHETIC-CREDENTIAL</Output>"]] as const) assert.throws(() => inspectSampleBody(format, body));
});

test("business/namespace URLs remain inert while embedded credentials/auth queries are rejected", () => {
  const body = '<Output xmlns="http://www.w3.org/example" Type="listRouteDetail1"><DocRouteDetail ProductLink="https://products.invalid/appliance?model=SYNTHETIC-1&amp;view=details"/></Output>';
  assert.equal(inspectSampleBody("xml", body).structure.format, "xml");
  assert.equal(inspectSampleBody("json", '{"productUrl":"https://products.invalid/appliance?model=SYNTHETIC-1"}').structure.format, "json");
  for (const url of ["https://synthetic:synthetic@products.invalid/x", "https://products.invalid/x?access_token=synthetic", "https://products.invalid/x?X-Amz-Signature=synthetic", "https://products.invalid/x#token=synthetic", "https://products.invalid/x?%53TKN=synthetic", "javascript:synthetic()", "file:///synthetic/private"]) assert.throws(() => inspectSampleBody("json", JSON.stringify({ link: url })));
  assert.throws(() => inspectSampleBody("xml", '<root link="https://products.invalid/x?model=SYNTHETIC&amp;to&#107;en=synthetic"/>'), /secret\/auth/);
});

test("Route Planner context preserves mid-route stops/line identities and route-local order relationships without assigning leg roles", () => {
  // SyntheticLocation/SyntheticSequence are local fixture attributes, NOT an
  // asserted real Route Planner location schema. Only element/OrderID names
  // come from the observed owner-described family; Type codes remain raw.
  const body = '<Output Type="listRouteDetail1"><parmDocRouteDetail><DocRouteDetail RouteID="SYNTHETIC-R1"><FWStop OrderID="SYNTHETIC-A" Type="66" Status="Planned" SyntheticLocation="SYNTHETIC-DEPOT-5288" SyntheticSequence="1"><FWOrderLine OrderID="SYNTHETIC-A" LineID="SYNTHETIC-A1" Qty="1"/></FWStop><FWStop OrderID="SYNTHETIC-A" Type="67" SyntheticLocation="SYNTHETIC-CUSTOMER-A" SyntheticSequence="2"><FWOrderLine OrderID="SYNTHETIC-A" LineID="SYNTHETIC-A1" Qty="1"/></FWStop><FWStop OrderID="SYNTHETIC-B" Type="66" Status="Pending" SyntheticLocation="SYNTHETIC-MIDROUTE-STORE" SyntheticSequence="3"><FWOrderLine OrderID="SYNTHETIC-B" LineID="SYNTHETIC-B1" Qty="2"/><FWOrderLine OrderID="SYNTHETIC-B" LineID="SYNTHETIC-B2" Qty="1"/></FWStop><FWStop OrderID="SYNTHETIC-B" Type="67" SyntheticLocation="SYNTHETIC-CUSTOMER-B" SyntheticSequence="4"><FWOrderLine OrderID="SYNTHETIC-B" LineID="SYNTHETIC-B1" Qty="2"/></FWStop></DocRouteDetail><DocRouteDetail RouteID="SYNTHETIC-R2"><FWStop OrderID="SYNTHETIC-A" Type="99" SyntheticLocation="SYNTHETIC-OTHER-ROUTE"><FWOrderLine OrderID="SYNTHETIC-A" LineID="SYNTHETIC-A1"/></FWStop></DocRouteDetail></parmDocRouteDetail></Output>';
  const summary = inspectRoutePlannerContext(body); assert.equal(summary.routes.length, 2); assert.equal(summary.selectedRoute, null); assert.equal(JSON.stringify(summary).includes("SYNTHETIC-MIDROUTE-STORE"), false);
  assert.equal(summary.routes[0].stopCount, 4); assert.equal(summary.routes[0].orderLineCount, 5); assert.equal(summary.routes[0].distinctOrderIds, 2);
  const records: NonNullable<ReturnType<typeof inspectRoutePlannerContext>["selectedRoute"]>["records"] = [];
  let offset: number | null = 0;
  while (offset !== null) { const page = inspectRoutePlannerContext(body, { routePath: summary.routes[0].routePath, offset, limit: 3 }); records.push(...page.selectedRoute!.records); offset = page.selectedRoute!.nextOffset; }
  assert.equal(records.length, 10); assert.equal(new Set(records.map(record => record.sourcePath)).size, 10); assert.ok(records.every(record => record.legKind === "unknown"));
  assert.deepEqual(records.filter(record => record.elementName === "FWStop").map(record => record.attributes.find(attribute => attribute.name === "SyntheticLocation")?.value), ["SYNTHETIC-DEPOT-5288", "SYNTHETIC-CUSTOMER-A", "SYNTHETIC-MIDROUTE-STORE", "SYNTHETIC-CUSTOMER-B"]);
  assert.deepEqual(records.map(record => record.documentOrder), [...records.map(record => record.documentOrder)].sort((a, b) => a - b));
  const links = inspectRoutePlannerContext(body, { routePath: summary.routes[0].routePath, limit: 10 }).selectedRoute!.orderLinks;
  assert.equal(links.find(link => link.orderId === "SYNTHETIC-A")?.occurrenceCount, 4); assert.ok(links.every(link => link.sourcePaths.every(path => path.startsWith(summary.routes[0].routePath + "/"))));
  const status = inspectSampleBody("xml", body, { fieldPath: "/Output/parmDocRouteDetail/DocRouteDetail/FWStop/@Status" }); assert.ok(status.values?.items[1].sourcePath.endsWith("FWStop[2]/@Status"), "Optional attributes retain actual sibling context instead of flat-array joins.");
  assert.throws(() => inspectRoutePlannerContext(body, { routePath: "/unknown" }), /exact route path/); assert.throws(() => inspectRoutePlannerContext(body, { routePath: summary.routes[0].routePath, limit: 11 }), /bounded/);
  assert.equal(inspectRoutePlannerContext(body, { routeLimit: 1 }).nextRouteOffset, 1); assert.equal(inspectRoutePlannerContext(body, { routeOffset: 1, routeLimit: 1 }).routes[0].routePath, summary.routes[1].routePath);
  assert.match(summary.limitations, /never a physical-unit merge/); assert.ok(records.every(record => !("presence" in record) && !("completed" in record) && !("unitId" in record)));
});

test("all repeated line occurrences remain inspectable when line IDs repeat across a selected route", () => {
  const lines = Array.from({ length: 537 }, (_, index) => `<FWOrderLine OrderID="SYNTHETIC-ORDER" LineID="SYNTHETIC-LINE-${index % 467}"/>`).join("");
  const body = `<Output Type="listRouteDetail1"><parmDocRouteDetail><DocRouteDetail>${lines}</DocRouteDetail></parmDocRouteDetail></Output>`;
  const summary = inspectRoutePlannerContext(body), route = summary.routes[0]; assert.equal(route.orderLineCount, 537);
  const fields = inspectSampleBody("xml", body).structure.fields; const lineIds = fields.find(field => field.path.endsWith("FWOrderLine/@LineID"))!;
  assert.equal(lineIds.occurrences, 537); assert.equal(lineIds.distinctValues, 467);
  const last = inspectSampleBody("xml", body, { fieldPath: lineIds.path, offset: 536, limit: 1 }).values!;
  assert.ok(last.items[0].sourcePath.endsWith("FWOrderLine[536]/@LineID")); assert.equal(last.nextOffset, null);
  const tail = inspectRoutePlannerContext(body, { routePath: route.routePath, offset: 531, limit: 10 }).selectedRoute!; assert.equal(tail.records.length, 7); assert.equal(tail.nextOffset, null); assert.equal(tail.orderLinks[0].occurrenceCount, 537); assert.equal(tail.orderLinks[0].moreSourcePaths, true);
});
