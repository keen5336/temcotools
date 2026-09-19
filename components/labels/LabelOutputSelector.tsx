"use client";

import type { OperatorPrinter, OperatorTemplate } from "@/components/labels/useLabelConfiguration";
import { useLabelRelayPreference } from "./useLabelRelayPreference";
import LabelRelayStatus from "./LabelRelayStatus";

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
  const { relayEnabled, setRelayEnabled } = useLabelRelayPreference();
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
      <div className="sm:col-span-2 rounded-lg bg-base-200 p-3 space-y-2">
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span className="font-semibold">Use label relay</span>
          <input type="checkbox" className="toggle toggle-primary" checked={relayEnabled} onChange={(event) => setRelayEnabled(event.target.checked)} />
        </label>
        <p className="text-xs text-base-content/70">Send labels through a laptop with Label Relay Mode on. Saved for all label pages on this device.</p>
        {relayEnabled && <LabelRelayStatus printerId={props.printerId} />}
      </div>
      {props.error && <p className="text-sm text-error sm:col-span-2">{props.error}</p>}
      {!props.loading && (!props.printers.length || !props.templates.length) && (
        <p className="text-sm text-warning sm:col-span-2">Printing is unavailable until a manager activates both a printer destination and a template.</p>
      )}
    </div>
  );
}
