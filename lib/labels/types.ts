export const LABEL_PURPOSES = ["unit_identity", "put_away", "delivery_staging", "office_disposition", "rtv_submission", "legacy_manual"] as const;
export type LabelPurpose = (typeof LABEL_PURPOSES)[number];
export const LABEL_FIELDS = ["unitId", "lpn", "msn", "serialNumber", "submissionNumber", "orderNumber", "vendor", "modelNumber", "submittedBy", "vendorRaNumber", "dateSubmitted", "deliveryDate", "routeNumber", "stagingLocation", "lane", "disposition", "instructions", "description", "receivedDate", "contact", "today", "partNumber", "trackingNumber", "hold", "identityResolved"] as const;
export type LabelField = (typeof LABEL_FIELDS)[number];
export type LabelFields = Partial<Record<LabelField, string>>;
export const LABEL_RULE_CLASSES = ["safety_hold", "unit_disposition", "dispatch", "default"] as const;
export type LabelRule = { id: string; name: string; class: (typeof LABEL_RULE_CLASSES)[number]; priority: number; enabled: boolean; automatic: boolean; conditions: { field: LabelField; operator: "equals" | "not_equals" | "empty" | "not_empty"; value?: string }[] };
export interface LabelDraft { purpose: LabelPurpose; name: string; zpl: string; requiredFields: LabelField[]; rules: LabelRule[]; widthMm: number; heightMm: number; dpi: number }
export interface ManagedPrinter { id: string; name: string; endpoint: string; contentType: string }
export interface LabelDispatchClaim { dispatch: true; issuanceId: string; deviceId: string; reportToken: string; printer: ManagedPrinter; zpl: string }
export type LabelDeliveryStatus = "sent_unconfirmed" | "unknown" | "not_sent";
export const GENERIC_LABEL_ZPL = "^XA\n^CI28\n^PW812\n^LL609\n^FO25,25^A0N,45,45^FD{{lpn}}^FS\n^FO25,100^A0N,32,32^FD{{description}}^FS\n^FO25,160^A0N,36,36^FD{{instructions}}^FS\n^FO25,240^A0N,40,40^FD{{stagingLocation}}^FS\n^FO25,340^A0N,32,32^FD{{deliveryDate}}^FS\n^FO25,420^BCN,100,Y,N,N^FD{{lpn}}^FS\n^XZ";
