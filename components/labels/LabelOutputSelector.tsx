"use client";

import type { OperatorPrinter, OperatorTemplate } from "@/components/labels/useLabelConfiguration";

interface Props {
  printers: OperatorPrinter[];
  templates: OperatorTemplate[];
  printerId: string;
  templateId: string;
  onPrinterChange: (id: string) => void;
  onTemplateChange: (id: string) => void;
  loading?: boolean;
  error?: string;
}

export default function LabelOutputSelector(props: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="form-control">
        <span className="label-text mb-1 font-semibold">Label template</span>
        <select className="select select-bordered" value={props.templateId} onChange={(event) => props.onTemplateChange(event.target.value)} disabled={props.loading || props.templates.length === 0}>
          {props.templates.length === 0 && <option value="">No active templates</option>}
          {props.templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="form-control">
        <span className="label-text mb-1 font-semibold">Where to print</span>
        <select className="select select-bordered" value={props.printerId} onChange={(event) => props.onPrinterChange(event.target.value)} disabled={props.loading || props.printers.length === 0}>
          {props.printers.length === 0 && <option value="">No printer configured</option>}
          {props.printers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {props.error && <p className="text-sm text-error sm:col-span-2">{props.error}</p>}
      {!props.loading && (!props.printers.length || !props.templates.length) && (
        <p className="text-sm text-warning sm:col-span-2">Printing is unavailable until a manager activates both a printer destination and a template.</p>
      )}
    </div>
  );
}
