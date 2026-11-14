import { z } from "zod";

export const PAGE_TYPES = ["sth", "home-delivery", "revisit"] as const;
export const PAGE_LABELS = { sth: "STH - Outside Delivery", "home-delivery": "Home Delivery", revisit: "Revisit" };
export const FIELD_LABELS = { order: "Order", dwo: "DWO", msn: "MSN", eta: "ETA", weight: "Weight", pallets: "Pallets", serviceType: "Service Type" };
export const TEMPLATE_FIELDS = ["route", "driver", "date", "miles", "customer", "address", "order", "serviceType", "stop", "pageType"] as const;
export type RichNode = { type: string; text?: string; content?: RichNode[]; marks?: { type: string }[]; attrs?: { start?: number; type?: null; name?: string } };
const paragraph = (text: string): RichNode => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) });
const doc = (...content: RichNode[]): RichNode => ({ type: "doc", content });
const list = (entries: string[]) => doc({ type: "bulletList", content: entries.map(text => ({ type: "listItem", content: [paragraph(text)] })) });
const notes = () => doc(paragraph(""));

export const DEFAULT_TEMPLATES = {
  schemaVersion: 1 as const,
  coverReminders: list(["Call all customers 30 minutes ahead", "Complete route before leaving final stop", "Mention survey post delivery", "Must wait 5 minutes before closing a stop"]),
  coverAttention: notes(),
  appPod: list(["Customer signs on handheld", "Permission for indoor photos", "Entire order visible", "Minimum 3 photos", "House number if missed"]),
  sthPod: list(["Photos of 2 box sides", "PO label visible", "3+ photos for multi pallet", "Product condition visible"]),
  surveyTitle: doc({ type: "paragraph", content: [{ type: "text", text: "Don’t Forget About" }, { type: "hardBreak" }, { type: "text", text: "Our Survey!" }] }),
  surveyExperience: doc(paragraph("The questions asked are only about your experience with the delivery team that was in your home Today!")),
  surveyRating: doc({ type: "paragraph", content: [{ type: "text", text: "Questions are rated out of 5 " }, { type: "text", text: "(Extremely Likely)", marks: [{ type: "italic" }] }, { type: "text", text: ", anything below a 5 is considered failing for our delivery teams!" }] }),
  surveyNotes: list(["Remember the delivery drivers only deliver and install they have no impact on shipping delays or store issues.", "These surveys also help to keep these delivery teams working!", "We appreciate all feedback regarding any issues with stores and teams in the comment section! Both the delivery provider and Home Depot read the comments daily! And we use them to coach and provide feedback to our stores and delivery teams."]),
  contacts: [
    [{ name: "Dispatch", phone: "612-268-1765" }, { name: "Thomas", phone: "909-737-2941" }],
    [{ name: "", phone: "" }, { name: "Pedro", phone: "909-701-4640" }],
    [{ name: "Samantha", phone: "909-528-0728" }, { name: "Brent", phone: "909-893-5395" }],
    [{ name: "Ron", phone: "909-642-1224" }, { name: "John", phone: "909-676-3349" }],
    [{ name: "Shafec", phone: "909-665-6051" }, { name: "Juan", phone: "909-694-7194" }],
    [{ name: "Charlie", phone: "909-528-0327" }, { name: "Jose", phone: "909-675-2309" }],
  ],
  pages: {
    sth: { fields: ["order", "dwo", "serviceType"], quantity: true, sku: true, showRouteDate: false, notes: notes() },
    "home-delivery": { fields: ["order", "msn", "serviceType"], quantity: true, sku: true, showRouteDate: true, notes: notes() },
    revisit: { fields: ["order", "serviceType"], quantity: false, sku: false, showRouteDate: true, notes: notes() },
  },
};

function validDocument(value: unknown): value is RichNode {
  let count = 0;
  function visit(node: unknown, parent: string, depth: number): boolean {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 8 || ++count > 1200) return false;
    const n = node as RichNode;
    if (Object.keys(n).some(key => !["type", "text", "content", "marks", "attrs"].includes(key))) return false;
    const children: Record<string, string[]> = { root: ["doc"], doc: ["paragraph", "bulletList", "orderedList"], paragraph: ["text", "hardBreak", "templateField"], bulletList: ["listItem"], orderedList: ["listItem"], listItem: ["paragraph", "bulletList", "orderedList"] };
    if (!children[parent]?.includes(n.type)) return false;
    if (n.type === "text") {
      if (typeof n.text !== "string" || !n.text || n.text.length > 4000 || n.content !== undefined || n.attrs !== undefined) return false;
      if (n.marks !== undefined && (!Array.isArray(n.marks) || n.marks.length > 4 || n.marks.some(mark => !mark || Object.keys(mark).length !== 1 || !["bold", "italic", "underline", "strike"].includes(mark.type)))) return false;
      const tokens = n.text.matchAll(/\{\{([^{}]*)\}\}/g);
      for (const [, key] of tokens) if (!(TEMPLATE_FIELDS as readonly string[]).includes(key.trim())) return false;
      return true;
    }
    if (n.text !== undefined || n.marks !== undefined) return false;
    if (n.type === "templateField") return !n.content && !!n.attrs && Object.keys(n.attrs).length === 1 && (TEMPLATE_FIELDS as readonly unknown[]).includes(n.attrs.name);
    if (n.type === "hardBreak") return n.content === undefined && n.attrs === undefined;
    if (n.attrs !== undefined && (!n.attrs || typeof n.attrs !== "object" || Array.isArray(n.attrs) || n.type !== "orderedList" || Object.keys(n.attrs).some(key => !["start", "type"].includes(key)) || (n.attrs.start !== undefined && (!Number.isInteger(n.attrs.start) || n.attrs.start < 1 || n.attrs.start > 99)) || (n.attrs.type !== undefined && n.attrs.type !== null))) return false;
    if (n.content === undefined) return n.type === "paragraph";
    if (!Array.isArray(n.content) || !n.content.every(child => visit(child, n.type, depth + 1))) return false;
    return n.type === "paragraph" || (n.content.length > 0 && (n.type !== "listItem" || n.content[0].type === "paragraph"));
  }
  return visit(value, "root", 0);
}
const richDocument = z.custom<RichNode>(validDocument, "Use paragraphs, lists, bold, italic, underline and the listed template fields only.");
const fields = z.array(z.enum(["order", "dwo", "msn", "eta", "weight", "pallets", "serviceType"])).max(7).refine(values => new Set(values).size === values.length, "Duplicate fields are not allowed.");
const page = z.object({ fields, quantity: z.boolean(), sku: z.boolean(), showRouteDate: z.boolean(), notes: richDocument }).strict();
const contact = z.object({ name: z.string().max(30), phone: z.string().max(30) }).strict();
export const templateSchema = z.object({
  schemaVersion: z.literal(1), coverReminders: richDocument, coverAttention: richDocument, appPod: richDocument, sthPod: richDocument,
  surveyTitle: richDocument, surveyExperience: richDocument, surveyRating: richDocument, surveyNotes: richDocument,
  contacts: z.array(z.tuple([contact, contact])).length(6),
  pages: z.object({ sth: page, "home-delivery": page, revisit: page }).strict(),
}).strict().refine(value => JSON.stringify(value).length <= 100_000, "Templates are too large.");
export type PaperworkTemplates = z.infer<typeof templateSchema>;
export type PageType = typeof PAGE_TYPES[number];
export const saveSchema = z.object({ expectedVersion: z.number().int().min(0), operationId: z.uuid(), template: templateSchema, program: z.string().max(180_000) }).strict();
