export const DEFAULT_PICK_WAVE_TEMPLATE = `^XA
^CI28
^PW812
^LL1280
^LH0,0

^FO24,25^A0N,28,28^FDSTAGING LOCATION^FS
^FO24,65^GB764,245,5^FS
^FO40,105^A0N,150,130^FB730,2,0,C^FD{{stagingLocation}}^FS

^FO24,340^A0N,28,28^FDCONTACT^FS
^FO24,375^A0N,55,55^FD{{contact}}^FS

^FO24,460^A0N,28,28^FDORDER NUMBER^FS
^FO24,495^A0N,52,52^FD{{orderNumber}}^FS
^FO430,460^A0N,28,28^FDTODAY'S DATE^FS
^FO430,495^A0N,52,52^FD{{today}}^FS

^FO24,575^A0N,28,28^FDLPN^FS
^FO24,610^A0N,60,60^FD{{lpn}}^FS

^FO24,700^A0N,28,28^FDSERIAL NUMBER^FS
^FO24,735^A0N,60,60^FD{{serialNumber}}^FS

^FO24,825^A0N,28,28^FDPART NUMBER^FS
^FO24,860^A0N,60,60^FD{{partNumber}}^FS

^BY3,2,105
^FO70,990^BCN,105,Y,N,N^FD{{lpn}}^FS
^FO24,1190^A0N,24,24^FDRoute {{routeNumber}}^FS
^XZ`;

export interface PickWaveLabelFields {
  stagingLocation: string;
  contact: string;
  orderNumber: string;
  lpn: string;
  serialNumber: string;
  today: string;
  partNumber: string;
  routeNumber: string;
}

export function renderPickWaveLabel(template: string, fields: PickWaveLabelFields) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => sanitize(fields[key as keyof PickWaveLabelFields] ?? ""));
}

function sanitize(value: string) {
  return String(value ?? "").replace(/[\^~]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
