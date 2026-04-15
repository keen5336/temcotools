export const DEFAULT_TEMPLATE_ID = "default-rtv-4x3";
export const DEFAULT_TEMPLATE_NAME = "Default RTV 4x3";

export const DEFAULT_TEMPLATE_ZPL = `^XA
^CI28
^PW812
^LL1280
^LH0,0

^FO35,40^A0N,300,280^FDMARS^FS
^BY3,2,100
^FO610,860^BCR,100,Y,N,N^FD{{submissionNumber}}^FS

^FO24,360^A0N,24,24^FDSERIAL^FS
^FO24,392^A0N,70,70^FD{{serialNumber}}^FS

^FO24,480^A0N,35,35^FDSUBMISSION #^FS
^FO24,515^A0N,80,80^FD{{submissionNumber}}^FS

^FO450,480^A0N,35,35^FDVENDOR^FS
^FO450,515^A0N,80,80^FD{{vendor}}^FS

^FO24,595^A0N,35,35^FDDATE SUBMITTED^FS
^FO24,630^A0N,70,70^FD{{dateSubmitted}}^FS

^FO24,705^A0N,35,35^FDORDER^FS
^FO24,745^A0N,70,70^FD{{orderNumber}}^FS

^FO24,815^A0N,35,35^FDMODEL #^FS
^FO24,855^A0N,70,70^FD{{modelNumber}}^FS

^FO24,925^A0N,35,35^FDSUBMITTED BY^FS
^FO24,965^A0N,70,70^FD{{submittedBy}}^FS

^FO24,1035^A0N,35,35^FDVENDOR RA^FS
^FO24,1075^A0N,70,70^FD{{vendorRaNumber}}^FS

^XZ`;

export interface LabelFields {
  serialNumber: string;
  dateSubmitted: string;
  submissionNumber: string;
  orderNumber: string;
  vendor: string;
  modelNumber: string;
  submittedBy: string;
  vendorRaNumber: string;
}

export interface Template {
  id: string;
  name: string;
  content: string;
  isDefault?: boolean;
}

export function emptyLabelFields(): LabelFields {
  return {
    serialNumber: "",
    dateSubmitted: "",
    submissionNumber: "",
    orderNumber: "",
    vendor: "",
    modelNumber: "",
    submittedBy: "",
    vendorRaNumber: "",
  };
}

export function sanitizeText(value: string): string {
  return String(value ?? "")
    .replace(/[\^~]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLines(text: string): string[] {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getValueAfterLabel(
  lines: string[],
  label: string,
  occurrence: "first" | "last" = "last"
): string {
  const needle = label.toLowerCase();
  const indexes: number[] = [];
  lines.forEach((line, idx) => {
    if (line.toLowerCase() === needle) indexes.push(idx);
  });
  if (!indexes.length) return "";
  const index = occurrence === "first" ? indexes[0] : indexes[indexes.length - 1];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

export function extractInlineValue(text: string, label: string): string {
  const re = new RegExp(
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*#?\\s*([^\\n\\r]+)",
    "i"
  );
  const match = String(text).match(re);
  return match ? match[1].trim() : "";
}

export function parseFields(text: string): LabelFields {
  const lines = normalizeLines(text);
  return {
    orderNumber: getValueAfterLabel(lines, "Order #") || extractInlineValue(text, "Order"),
    vendor: getValueAfterLabel(lines, "Vendor"),
    serialNumber: getValueAfterLabel(lines, "Serial #") || extractInlineValue(text, "Serial"),
    modelNumber: getValueAfterLabel(lines, "Model #") || extractInlineValue(text, "Model"),
    submissionNumber:
      getValueAfterLabel(lines, "Submission #") || extractInlineValue(text, "Submission"),
    submittedBy: getValueAfterLabel(lines, "Return Submitted By"),
    vendorRaNumber:
      getValueAfterLabel(lines, "Vendor RA #") || extractInlineValue(text, "Vendor RA"),
    dateSubmitted: getValueAfterLabel(lines, "Date Submitted"),
  };
}

export function renderTemplate(templateString: string, data: LabelFields): string {
  return templateString.replace(/{{\s*(\w+)\s*}}/g, (_, key) =>
    sanitizeText((data as unknown as Record<string, string>)[key] ?? "")
  );
}

export function safeField(value: string): string {
  return sanitizeText(value) || "UNKNOWN";
}

export function buildDefaultTemplates(): Record<string, Template> {
  return {
    [DEFAULT_TEMPLATE_ID]: {
      id: DEFAULT_TEMPLATE_ID,
      name: DEFAULT_TEMPLATE_NAME,
      content: DEFAULT_TEMPLATE_ZPL,
      isDefault: true,
    },
  };
}
