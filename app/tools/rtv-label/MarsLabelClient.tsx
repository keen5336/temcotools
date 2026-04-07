"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  templates: "mars-label-tool.templates",
  activeTemplateId: "mars-label-tool.activeTemplateId",
  printerEndpoint: "mars-label-tool.printerEndpoint",
  contentType: "mars-label-tool.contentType",
};

const DEFAULT_TEMPLATE_ID = "default-rtv-4x3";
const STATUS_RESET_DELAY_MS = 2500;
const DEFAULT_TEMPLATE_NAME = "Default RTV 4x3";

const DEFAULT_TEMPLATE_ZPL = `^XA
^CI28
^PW812
^LL1180
^LH0,0

^FO24,22^A0N,24,24^FDSERIAL^FS
^FO24,54^A0N,72,72^FD{{serialNumber}}^FS

^FO24,150^GB764,140,2^FS
^FO40,160^A0N,48,48^FDSUBMISSION #^FS
^FO40,210^A0N,100,100^FD{{submissionNumber}}^FS

^FO24,310^GB764,140,2^FS
^FO40,320^A0N,48,48^FDDATE SUBMITTED^FS
^FO40,370^A0N,72,72^FD{{dateSubmitted}}^FS

^FO24,470^GB764,120,2^FS
^FO40,480^A0N,40,40^FDORDER^FS
^FO40,525^A0N,84,84^FD{{orderNumber}}^FS

^FO24,610^GB764,120,2^FS
^FO40,620^A0N,40,40^FDVENDOR^FS
^FO40,665^A0N,84,84^FD{{vendor}}^FS

^FO24,750^GB764,120,2^FS
^FO40,760^A0N,40,40^FDMODEL #^FS
^FO40,805^A0N,84,84^FD{{modelNumber}}^FS

^FO24,890^GB764,120,2^FS
^FO40,900^A0N,40,40^FDSUBMITTED BY^FS
^FO40,945^A0N,84,84^FD{{submittedBy}}^FS

^FO24,1030^GB764,120,2^FS
^FO40,1040^A0N,40,40^FDVENDOR RA^FS
^FO40,1085^A0N,84,84^FD{{vendorRaNumber}}^FS

^XZ`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface LabelFields {
  serialNumber: string;
  dateSubmitted: string;
  submissionNumber: string;
  orderNumber: string;
  vendor: string;
  modelNumber: string;
  submittedBy: string;
  vendorRaNumber: string;
}

interface Template {
  id: string;
  name: string;
  content: string;
  isDefault?: boolean;
}

type StatusTone = "default" | "ok" | "warn" | "error";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeText(value: string): string {
  return String(value ?? "")
    .replace(/[\^~]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLines(text: string): string[] {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getValueAfterLabel(
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

function extractInlineValue(text: string, label: string): string {
  const re = new RegExp(
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*#?\\s*([^\\n\\r]+)",
    "i"
  );
  const match = String(text).match(re);
  return match ? match[1].trim() : "";
}

function parseFields(text: string): LabelFields {
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

function renderTemplate(templateString: string, data: LabelFields): string {
  return templateString.replace(/{{\s*(\w+)\s*}}/g, (_, key) =>
    sanitizeText((data as unknown as Record<string, string>)[key] ?? "")
  );
}

function safeField(value: string): string {
  return sanitizeText(value) || "UNKNOWN";
}

function buildDefaultTemplates(): Record<string, Template> {
  return {
    [DEFAULT_TEMPLATE_ID]: {
      id: DEFAULT_TEMPLATE_ID,
      name: DEFAULT_TEMPLATE_NAME,
      content: DEFAULT_TEMPLATE_ZPL,
      isDefault: true,
    },
  };
}

function loadTemplatesFromStorage(): Record<string, Template> {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.templates);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Template>;
      if (!parsed[DEFAULT_TEMPLATE_ID]) {
        parsed[DEFAULT_TEMPLATE_ID] = buildDefaultTemplates()[DEFAULT_TEMPLATE_ID];
      }
      return parsed;
    }
  } catch {
    // ignore
  }
  return buildDefaultTemplates();
}

function persistToStorage(
  templates: Record<string, Template>,
  activeTemplateId: string,
  printerEndpoint: string,
  contentType: string
) {
  localStorage.setItem(STORAGE_KEYS.templates, JSON.stringify(templates));
  localStorage.setItem(STORAGE_KEYS.activeTemplateId, activeTemplateId);
  localStorage.setItem(STORAGE_KEYS.printerEndpoint, printerEndpoint);
  localStorage.setItem(STORAGE_KEYS.contentType, contentType);
}

function sortedTemplates(templates: Record<string, Template>): Template[] {
  return Object.values(templates).sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MarsLabelClient() {
  const [fields, setFields] = useState<LabelFields>({
    serialNumber: "",
    dateSubmitted: "",
    submissionNumber: "",
    orderNumber: "",
    vendor: "",
    modelNumber: "",
    submittedBy: "",
    vendorRaNumber: "",
  });

  const [sourceText, setSourceText] = useState("");
  const [templates, setTemplates] = useState<Record<string, Template>>({});
  const [activeTemplateId, setActiveTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [templateEditorContent, setTemplateEditorContent] = useState(DEFAULT_TEMPLATE_ZPL);
  const [templateName, setTemplateName] = useState(DEFAULT_TEMPLATE_NAME);
  const [printerEndpoint, setPrinterEndpoint] = useState("http://localhost:3000");
  const [contentType, setContentType] = useState("text/plain");
  const [status, setStatus] = useState<{ message: string; tone: StatusTone }>({
    message: "Ready",
    tone: "default",
  });
  const [zplOutput, setZplOutput] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const parseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const tpls = loadTemplatesFromStorage();
    const savedActiveId = localStorage.getItem(STORAGE_KEYS.activeTemplateId);
    const resolvedActiveId =
      savedActiveId && tpls[savedActiveId] ? savedActiveId : DEFAULT_TEMPLATE_ID;

    setTemplates(tpls);
    setActiveTemplateId(resolvedActiveId);
    setTemplateEditorContent(tpls[resolvedActiveId]?.content ?? DEFAULT_TEMPLATE_ZPL);
    setTemplateName(tpls[resolvedActiveId]?.name ?? DEFAULT_TEMPLATE_NAME);
    setPrinterEndpoint(
      localStorage.getItem(STORAGE_KEYS.printerEndpoint) || "http://localhost:3000"
    );
    setContentType(localStorage.getItem(STORAGE_KEYS.contentType) || "text/plain");
    setHydrated(true);
  }, []);

  const showStatus = useCallback((message: string, tone: StatusTone = "default") => {
    setStatus({ message, tone });
  }, []);

  const computeZpl = useCallback(
    (currentFields: LabelFields, editorContent: string): string => {
      return renderTemplate(editorContent, currentFields);
    },
    []
  );

  // Re-render ZPL whenever fields or template editor changes
  useEffect(() => {
    if (!hydrated) return;
    setZplOutput(computeZpl(fields, templateEditorContent));
  }, [fields, templateEditorContent, hydrated, computeZpl]);

  // Auto-parse source text after debounce
  useEffect(() => {
    if (!hydrated) return;
    if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
    if (!sourceText.trim()) return;
    parseTimerRef.current = setTimeout(() => {
      const parsed = parseFields(sourceText);
      setFields(parsed);
      showStatus("Fields parsed", "ok");
    }, 120);
    return () => {
      if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
    };
  }, [sourceText, hydrated, showStatus]);

  function handleFieldChange(key: keyof LabelFields, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleResetFields() {
    setFields({
      serialNumber: "",
      dateSubmitted: "",
      submissionNumber: "",
      orderNumber: "",
      vendor: "",
      modelNumber: "",
      submittedBy: "",
      vendorRaNumber: "",
    });
    showStatus("Fields reset");
  }

  function handleRefreshPreview() {
    setZplOutput(computeZpl(fields, templateEditorContent));
    showStatus("Preview refreshed");
  }

  async function handleCopyZpl() {
    try {
      await navigator.clipboard.writeText(zplOutput);
      showStatus("ZPL copied", "ok");
    } catch {
      showStatus("Could not copy ZPL", "error");
    }
  }

  async function handlePrint() {
    const endpoint = printerEndpoint.trim();
    if (!endpoint) {
      showStatus("Set printer endpoint first", "warn");
      return;
    }
    localStorage.setItem(STORAGE_KEYS.printerEndpoint, endpoint);
    localStorage.setItem(STORAGE_KEYS.contentType, contentType);
    showStatus("Sending label...", "ok");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: zplOutput + "\x04",
        keepalive: false,
        mode: "no-cors",
        cache: "no-store",
        signal: controller.signal,
      });
      showStatus("Label sent", "ok");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        showStatus("Label sent", "ok");
      } else {
        console.error("Printer Fetch Error:", err);
        showStatus("Label sent", "ok");
      }
    } finally {
      clearTimeout(timeoutId);
      setTimeout(() => showStatus("Ready"), STATUS_RESET_DELAY_MS);
    }
  }

  function handleSwitchTemplate(templateId: string) {
    if (!templates[templateId]) return;
    const tpl = templates[templateId];
    setActiveTemplateId(templateId);
    setTemplateEditorContent(tpl.content);
    setTemplateName(tpl.name);
    persistToStorage(templates, templateId, printerEndpoint, contentType);
    showStatus("Template loaded");
  }

  function handleSaveTemplate() {
    const name = templateName.trim();
    if (!name) {
      showStatus("Template name is required", "warn");
      return;
    }
    const updated: Record<string, Template> = {
      ...templates,
      [activeTemplateId]: {
        ...templates[activeTemplateId],
        name,
        content: templateEditorContent,
      },
    };
    setTemplates(updated);
    persistToStorage(updated, activeTemplateId, printerEndpoint, contentType);
    showStatus("Template saved", "ok");
  }

  function handleNewTemplate() {
    const name = templateName.trim() || `Custom Template ${new Date().toISOString()}`;
    const id = "tpl-" + crypto.randomUUID();
    const newTpl: Template = { id, name, content: templateEditorContent || DEFAULT_TEMPLATE_ZPL };
    const updated = { ...templates, [id]: newTpl };
    setTemplates(updated);
    setActiveTemplateId(id);
    setTemplateName(name);
    persistToStorage(updated, id, printerEndpoint, contentType);
    showStatus("New template created", "ok");
  }

  function handleDeleteTemplate() {
    const tpl = templates[activeTemplateId];
    if (!tpl) return;
    if (tpl.isDefault) {
      showStatus("Default template cannot be deleted", "warn");
      return;
    }
    const updated = { ...templates };
    delete updated[activeTemplateId];
    setTemplates(updated);
    setActiveTemplateId(DEFAULT_TEMPLATE_ID);
    setTemplateEditorContent(updated[DEFAULT_TEMPLATE_ID]?.content ?? DEFAULT_TEMPLATE_ZPL);
    setTemplateName(updated[DEFAULT_TEMPLATE_ID]?.name ?? DEFAULT_TEMPLATE_NAME);
    persistToStorage(updated, DEFAULT_TEMPLATE_ID, printerEndpoint, contentType);
    showStatus("Template deleted", "ok");
  }

  function handleRestoreDefault() {
    const defaultTpl: Template = {
      id: DEFAULT_TEMPLATE_ID,
      name: DEFAULT_TEMPLATE_NAME,
      content: DEFAULT_TEMPLATE_ZPL,
      isDefault: true,
    };
    const updated = { ...templates, [DEFAULT_TEMPLATE_ID]: defaultTpl };
    setTemplates(updated);
    setActiveTemplateId(DEFAULT_TEMPLATE_ID);
    setTemplateEditorContent(DEFAULT_TEMPLATE_ZPL);
    setTemplateName(DEFAULT_TEMPLATE_NAME);
    persistToStorage(updated, DEFAULT_TEMPLATE_ID, printerEndpoint, contentType);
    showStatus("Default template restored", "ok");
  }

  const activeTemplate = templates[activeTemplateId];
  const statusClass =
    status.tone === "ok"
      ? "text-success border-success"
      : status.tone === "error"
      ? "text-error border-error"
      : status.tone === "warn"
      ? "text-warning border-warning"
      : "text-base-content/60 border-base-300";

  if (!hydrated) return null;

  return (
    <>
      {/* Two-column grid */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.95fr] gap-5 items-start">
        {/* Left column */}
        <div className="flex flex-col gap-5">
          {/* Step 1: Paste source text */}
          <div className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-4">
              <div>
                <h2 className="card-title text-base">1) Paste source text</h2>
                <p className="text-sm text-base-content/60 mt-1">
                  From the return page: <strong>Ctrl + A</strong>, <strong>Ctrl + C</strong>, paste
                  it here, then parse. The parser grabs the next non-empty line after each field
                  label.
                </p>
              </div>
              <div className="form-control">
                <label className="label">
                  <span className="label-text font-semibold">Page dump</span>
                </label>
                <textarea
                  className="textarea textarea-bordered font-mono min-h-48 resize-y"
                  spellCheck={false}
                  placeholder="Paste the copied return page text here..."
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      handlePrint();
                    }
                  }}
                  autoFocus
                />
              </div>
            </div>
          </div>

          {/* Step 2: Extracted fields */}
          <div className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-4">
              <div>
                <h2 className="card-title text-base">2) Extracted fields</h2>
                <p className="text-sm text-base-content/60 mt-1">
                  These are the values that feed the label. You can correct anything manually
                  before printing.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { id: "serialNumber" as const, label: "Serial #" },
                  { id: "dateSubmitted" as const, label: "Date Submitted" },
                  { id: "submissionNumber" as const, label: "Submission #" },
                  { id: "vendorRaNumber" as const, label: "Vendor RA #" },
                  { id: "orderNumber" as const, label: "Order #" },
                  { id: "vendor" as const, label: "Vendor" },
                  { id: "modelNumber" as const, label: "Model #" },
                  { id: "submittedBy" as const, label: "Return Submitted By" },
                ].map(({ id, label }) => (
                  <div key={id} className="form-control">
                    <label className="label">
                      <span className="label-text font-semibold">{label}</span>
                    </label>
                    <input
                      type="text"
                      className="input input-bordered input-sm"
                      value={fields[id]}
                      onChange={(e) => handleFieldChange(id, e.target.value)}
                    />
                  </div>
                ))}
              </div>

              <div className="flex gap-2 flex-wrap">
                <button className="btn btn-sm" onClick={handleRefreshPreview}>
                  Refresh preview
                </button>
                <button className="btn btn-sm btn-ghost" onClick={handleResetFields}>
                  Reset fields
                </button>
              </div>
            </div>
          </div>

          {/* Step 3: Printer */}
          <div className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-4">
              <div>
                <h2 className="card-title text-base">3) Printer</h2>
                <p className="text-sm text-base-content/60 mt-1">
                  Use direct raw printing only if your browser and printer allow it. Otherwise
                  point this at a tiny local print bridge like{" "}
                  <code className="text-xs">http://localhost:3000</code>.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
                <div className="form-control">
                  <label className="label">
                    <span className="label-text font-semibold">Printer / bridge endpoint</span>
                  </label>
                  <input
                    type="url"
                    className="input input-bordered input-sm"
                    placeholder="http://localhost:3000"
                    value={printerEndpoint}
                    onChange={(e) => setPrinterEndpoint(e.target.value)}
                  />
                </div>
                <div className="form-control">
                  <label className="label">
                    <span className="label-text font-semibold">Content-Type</span>
                  </label>
                  <select
                    className="select select-bordered select-sm"
                    value={contentType}
                    onChange={(e) => setContentType(e.target.value)}
                  >
                    <option value="text/plain">text/plain</option>
                    <option value="application/octet-stream">application/octet-stream</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                <button className="btn btn-sm btn-success" onClick={handlePrint}>
                  Print label
                </button>
                <button className="btn btn-sm" onClick={handleCopyZpl}>
                  Copy ZPL
                </button>
              </div>

              <div className="flex gap-2 flex-wrap">
                <span className="badge badge-outline badge-success text-xs">
                  Default template included
                </span>
                <span className="badge badge-outline text-xs">
                  Templates persist in local storage
                </span>
                <span className="badge badge-outline badge-warning text-xs">
                  Direct browser → port 9100 may fail
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-5">
          {/* Live label preview */}
          <div className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-4">
              <div>
                <h2 className="card-title text-base">Live label preview</h2>
                <p className="text-sm text-base-content/60 mt-1">
                  The white card is a visual preview. The actual printer uses the ZPL template
                  below.
                </p>
              </div>

              {/* Label preview card */}
              <div
                className="rounded-xl border border-base-300 bg-white text-[#111] p-4 w-full max-w-sm"
                style={{ aspectRatio: "4 / 3", overflow: "hidden", position: "relative" }}
              >
                <div className="text-[0.65rem] font-black uppercase tracking-widest text-[#555] mb-0.5">
                  Serial
                </div>
                <div className="text-2xl font-black leading-none tracking-wide mb-2 break-words">
                  {safeField(fields.serialNumber)}
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  {[
                    { k: "Submission", v: safeField(fields.submissionNumber) },
                    { k: "Date", v: safeField(fields.dateSubmitted) },
                  ].map(({ k, v }) => (
                    <div key={k} className="bg-[#f4f6fb] border border-[#dce3f4] rounded-lg p-2">
                      <div className="text-[0.55rem] font-black uppercase tracking-widest text-[#666]">
                        {k}
                      </div>
                      <div className="text-sm font-black mt-1 leading-tight break-words">{v}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mb-10">
                  {(
                    [
                      { k: "Order", v: safeField(fields.orderNumber) },
                      { k: "Vendor", v: safeField(fields.vendor) },
                      { k: "Model", v: safeField(fields.modelNumber) },
                      { k: "Submitted By", v: safeField(fields.submittedBy) },
                      { k: "Vendor RA", v: safeField(fields.vendorRaNumber), wide: true },
                    ] as Array<{ k: string; v: string; wide?: boolean }>
                  ).map(({ k, v, wide }) => (
                    <div key={k} className={wide ? "col-span-2" : ""}>
                      <div className="text-[0.55rem] font-black uppercase tracking-widest text-[#666]">
                        {k}
                      </div>
                      <div className="text-xs font-bold mt-0.5 leading-tight break-words">{v}</div>
                    </div>
                  ))}
                </div>

                {/* Decorative barcode strip */}
                <div
                  className="absolute left-4 right-4 bottom-4 h-10 rounded-t border border-b-0 border-[#aaa]"
                  style={{
                    background:
                      "repeating-linear-gradient(90deg,#111 0px,#111 2px,#fff 2px,#fff 4px,#111 4px,#111 5px,#fff 5px,#fff 8px,#111 8px,#111 12px,#fff 12px,#fff 14px)",
                  }}
                />
                <div className="absolute left-4 right-4 bottom-1 text-center font-mono text-[0.65rem] tracking-widest text-[#333]">
                  {safeField(fields.submissionNumber)}
                </div>
              </div>

              {/* KV grid */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { k: "Submission #", v: safeField(fields.submissionNumber) },
                  { k: "Active template", v: activeTemplate?.name ?? DEFAULT_TEMPLATE_NAME },
                ].map(({ k, v }) => (
                  <div
                    key={k}
                    className="bg-base-200/50 border border-base-300 rounded-xl p-3 min-h-16"
                  >
                    <div className="text-[0.7rem] text-base-content/50 uppercase tracking-widest mb-1.5">
                      {k}
                    </div>
                    <div className="font-bold text-sm break-words">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Template manager */}
          <div className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-4">
              <div>
                <h2 className="card-title text-base">Template manager</h2>
                <p className="text-sm text-base-content/60 mt-1">
                  Start from the default template, duplicate it, then tweak the ZPL. Use
                  placeholders like <code className="text-xs">{"{{serialNumber}}"}</code>.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="form-control">
                  <label className="label">
                    <span className="label-text font-semibold">Template</span>
                  </label>
                  <select
                    className="select select-bordered select-sm"
                    value={activeTemplateId}
                    onChange={(e) => handleSwitchTemplate(e.target.value)}
                  >
                    {sortedTemplates(templates).map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}
                        {tpl.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-control">
                  <label className="label">
                    <span className="label-text font-semibold">Template name</span>
                  </label>
                  <input
                    type="text"
                    className="input input-bordered input-sm"
                    placeholder="New template name"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                <button className="btn btn-sm" onClick={handleNewTemplate}>
                  New from current
                </button>
                <button className="btn btn-sm btn-primary" onClick={handleSaveTemplate}>
                  Save template
                </button>
                <button className="btn btn-sm btn-error" onClick={handleDeleteTemplate}>
                  Delete template
                </button>
                <button className="btn btn-sm btn-ghost" onClick={handleRestoreDefault}>
                  Restore default template
                </button>
              </div>

              <textarea
                className="textarea textarea-bordered font-mono text-xs min-h-52 resize-y bg-base-200"
                spellCheck={false}
                value={templateEditorContent}
                onChange={(e) => setTemplateEditorContent(e.target.value)}
              />

              <p className="text-xs text-base-content/50">
                Available placeholders:{" "}
                {[
                  "serialNumber",
                  "dateSubmitted",
                  "submissionNumber",
                  "orderNumber",
                  "vendor",
                  "modelNumber",
                  "submittedBy",
                  "vendorRaNumber",
                ].map((p) => (
                  <code key={p} className="text-xs mr-1">
                    {`{{${p}}}`}
                  </code>
                ))}
              </p>
            </div>
          </div>

          {/* Rendered ZPL */}
          <div className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-4">
              <div>
                <h2 className="card-title text-base">Rendered ZPL</h2>
                <p className="text-sm text-base-content/60 mt-1">
                  This is what gets sent to the printer or bridge endpoint.
                </p>
              </div>
              <textarea
                className="textarea textarea-bordered font-mono text-xs min-h-52 resize-y bg-base-200"
                spellCheck={false}
                readOnly
                value={zplOutput}
              />
              <p className="text-xs text-base-content/50">
                Label format tuned for a clean 4×3 layout: serial is dominant, submission and date
                are next, and the operational detail block stays readable without clutter.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky bottom bar */}
      <div className="sticky bottom-0 z-40 mt-5 px-4 py-3 border border-base-200 rounded-t-2xl bg-base-100/95 backdrop-blur flex items-center justify-between gap-3 shadow-[0_-10px_30px_rgba(0,0,0,0.12)]">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="text-sm font-black tracking-wide">Ready to print</div>
          <div className="text-xs text-base-content/50 truncate max-w-xl">
            Paste the return page text, let it auto-parse, then hit print. If the printer ignores
            the browser response, the label can still print successfully.
          </div>
        </div>
        <button className="btn btn-sm btn-success shrink-0" onClick={handlePrint}>
          Print label
        </button>
      </div>

      {/* Status pill — floats top-right */}
      <div
        role="status"
        aria-live="polite"
        className={`fixed top-16 right-4 z-50 border rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${statusClass}`}
      >
        {status.message}
      </div>
    </>
  );
}
