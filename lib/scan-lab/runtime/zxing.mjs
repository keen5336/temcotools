import { BrowserMultiFormatReader } from "@zxing/browser";
import {
  BarcodeFormat,
  DecodeHintType,
  NotFoundException,
  ChecksumException,
  FormatException,
} from "@zxing/library";
export function decode(canvas) {
  const hints = new Map([
    [
      DecodeHintType.POSSIBLE_FORMATS,
      [
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.ITF,
        BarcodeFormat.QR_CODE,
        BarcodeFormat.DATA_MATRIX,
        BarcodeFormat.PDF_417,
      ],
    ],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new BrowserMultiFormatReader(hints);
  try {
    const r = reader.decodeFromCanvas(canvas);
    return [
      {
        rawText: r.getText(),
        symbology: BarcodeFormat[r.getBarcodeFormat()],
        points: (r.getResultPoints() ?? []).map((p) => ({
          x: p.getX(),
          y: p.getY(),
        })),
      },
    ];
  } catch (e) {
    if (
      e instanceof NotFoundException ||
      e instanceof ChecksumException ||
      e instanceof FormatException
    )
      return [];
    throw e;
  }
}
