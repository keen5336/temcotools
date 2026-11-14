// Synthetic preview data only. Never send a live manifest through the editor.
export const SAMPLE_MANIFEST = `HOME DEPOT ROUTE MANIFEST
Route: SH31
Driver Name: SAMPLE, DRIVER
DATE: 11/14/2026
Total Distance (mi): 123.6
0
Location #\t3PL MDO 5288
${["STH - Outside Delivery", "Home Delivery", "MO - Revisit"].map((type, index) => `${index + 1}
Location #\tHD DELIVERY
Customer Order #\tSAMPLE-${index + 1}
DWO #\tDWO-${index + 1}
MSN #\tMSN-${index + 1}
ETA\t8:00 AM - 10:00 AM
Service Type\t${type}
\tSAMPLE CUSTOMER ${index + 1}\t${index + 1} Example Street, Minneapolis MN 55401\t120.5\t1
Qty\tSKU\tDescription
1\t00010\tSample appliance
2\t00020\tSample installation kit`).join("\n")}`;
