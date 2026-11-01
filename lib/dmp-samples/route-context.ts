import { DmpSampleError, inspectSampleBody, SAMPLE_LIMITS, type XmlSourceNode } from "./structure";

const orderId = (node: XmlSourceNode) => Object.entries(node.attributes).find(([key]) => key === "OrderID")?.[1];
const caveat = "Observed Route Planner XML structure only; selected routes are not all-day coverage. Document order, raw attributes and repeated line/stop occurrences are retained. Every leg role remains unknown. Type/Status/quantity do not establish pickup/delivery roles, appliance identity, warehouse presence or completion. OrderID links are route-local context, never a physical-unit merge.";

// This is a bounded private evidence view, not an upstream adapter or demand
// importer. Attribute names/values stay raw; no location schema is invented.
export function inspectRoutePlannerContext(body: string, query: { routePath?: string; offset?: number; limit?: number; routeOffset?: number; routeLimit?: number } = {}) {
  const nodes: XmlSourceNode[] = [];
  inspectSampleBody("xml", body, undefined, node => nodes.push(node));
  nodes.sort((a, b) => a.documentOrder - b.documentOrder);
  const output = nodes[0];
  if (output?.elementName !== "Output" || output.attributes.Type !== "listRouteDetail1") throw new DmpSampleError("This view recognizes only the observed Output Type=listRouteDetail1 XML family. Generic structure remains available; no alternate schema is assumed.", 400);
  const routes = nodes.filter(node => node.elementName === "DocRouteDetail");
  if (!routes.length) throw new DmpSampleError("This body has no observed DocRouteDetail elements. Use generic structure inspection.");
  const routeOf = new Map<string, string>(), recordsByRoute = new Map<string, XmlSourceNode[]>();
  for (const node of nodes) {
    const routePath = node.elementName === "DocRouteDetail" ? node.sourcePath : node.parentSourcePath ? routeOf.get(node.parentSourcePath) : undefined;
    if (!routePath) continue; routeOf.set(node.sourcePath, routePath);
    if (!recordsByRoute.has(routePath)) recordsByRoute.set(routePath, []);
    recordsByRoute.get(routePath)!.push(node);
  }
  const summaries = routes.map((route, routeIndex) => {
    const records = recordsByRoute.get(route.sourcePath)!, references = records.map(orderId).filter((value): value is string => value !== undefined);
    return { routePath: route.sourcePath, routeIndex, elementCount: records.length, stopCount: records.filter(node => node.elementName === "FWStop").length, orderLineCount: records.filter(node => node.elementName === "FWOrderLine").length, orderReferenceCount: references.length, distinctOrderIds: new Set(references).size };
  });
  const routeOffset = query.routeOffset ?? 0, routeLimit = query.routeLimit ?? 20;
  if (!Number.isInteger(routeOffset) || routeOffset < 0 || routeOffset > SAMPLE_LIMITS.nodes || !Number.isInteger(routeLimit) || routeLimit < 1 || routeLimit > 50) throw new DmpSampleError("Choose a bounded route-list page.");
  const base = { sourceFamily: "observed_route_detail_xml" as const, routes: summaries.slice(routeOffset, routeOffset + routeLimit), routeCount: routes.length, nextRouteOffset: routeOffset + routeLimit < routes.length ? routeOffset + routeLimit : null, limitations: caveat };
  if (!query.routePath) return { ...base, selectedRoute: null };
  const route = routes.find(node => node.sourcePath === query.routePath);
  if (!route) throw new DmpSampleError("Choose an exact route path from this private sample's context list.", 404);
  const offset = query.offset ?? 0, limit = query.limit ?? 5;
  if (!Number.isInteger(offset) || offset < 0 || offset > SAMPLE_LIMITS.nodes || !Number.isInteger(limit) || limit < 1 || limit > SAMPLE_LIMITS.routeContextRecords) throw new DmpSampleError("Choose a bounded route-context page.");
  const routeNodes = recordsByRoute.get(route.sourcePath)!, page = routeNodes.slice(offset, offset + limit);
  const pageOrderIds = new Set(page.map(orderId).filter((value): value is string => value !== undefined));
  const orderLinks = [...pageOrderIds].map(value => {
    const sourcePaths = routeNodes.filter(node => orderId(node) === value).map(node => node.sourcePath);
    return { orderId: value.slice(0, SAMPLE_LIMITS.returnedValueCharacters), orderIdTruncated: value.length > SAMPLE_LIMITS.returnedValueCharacters, occurrenceCount: sourcePaths.length, sourcePaths: sourcePaths.slice(0, SAMPLE_LIMITS.orderReferences), moreSourcePaths: sourcePaths.length > SAMPLE_LIMITS.orderReferences };
  });
  return {
    ...base,
    selectedRoute: { routePath: route.sourcePath, offset, totalRecords: routeNodes.length, nextOffset: offset + page.length < routeNodes.length ? offset + page.length : null,
      records: page.map(node => ({ sourcePath: node.sourcePath, parentSourcePath: node.parentSourcePath, documentOrder: node.documentOrder, elementName: node.elementName, legKind: "unknown" as const,
        attributes: Object.entries(node.attributes).map(([name, value]) => ({ name, value: value.slice(0, SAMPLE_LIMITS.returnedValueCharacters), truncated: value.length > SAMPLE_LIMITS.returnedValueCharacters })),
        text: node.text.slice(0, SAMPLE_LIMITS.returnedValueCharacters), textTruncated: node.text.length > SAMPLE_LIMITS.returnedValueCharacters,
      })), orderLinks,
    }, limitations: caveat,
  };
}
