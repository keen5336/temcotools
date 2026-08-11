"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LabelTemplateKindValue } from "@/lib/label-configuration";

export interface OperatorPrinter {
  id: string;
  name: string;
  endpoint: string;
  contentType: string;
}

export interface OperatorTemplate {
  id: string;
  name: string;
  zpl: string;
  isDefault: boolean;
}

interface OperatorConfiguration {
  printers: OperatorPrinter[];
  templates: OperatorTemplate[];
}

export function useLabelConfiguration(kind: LabelTemplateKindValue) {
  const [configuration, setConfiguration] = useState<OperatorConfiguration>({ printers: [], templates: [] });
  const [printerId, setPrinterIdState] = useState("");
  const [templateId, setTemplateIdState] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/label-config?kind=${kind}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load label configuration.");
      const next = data as OperatorConfiguration;
      setConfiguration(next);
      const savedPrinter = localStorage.getItem(`label-config.${kind}.printer`) ?? "";
      const savedTemplate = localStorage.getItem(`label-config.${kind}.template`) ?? "";
      setPrinterIdState(next.printers.some((item) => item.id === savedPrinter) ? savedPrinter : (next.printers[0]?.id ?? ""));
      setTemplateIdState(next.templates.some((item) => item.id === savedTemplate) ? savedTemplate : (next.templates.find((item) => item.isDefault)?.id ?? next.templates[0]?.id ?? ""));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load label configuration.");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { void load(); }, [load]);

  const setPrinterId = useCallback((id: string) => {
    setPrinterIdState(id);
    localStorage.setItem(`label-config.${kind}.printer`, id);
  }, [kind]);

  const setTemplateId = useCallback((id: string) => {
    setTemplateIdState(id);
    localStorage.setItem(`label-config.${kind}.template`, id);
  }, [kind]);

  const printer = useMemo(() => configuration.printers.find((item) => item.id === printerId) ?? null, [configuration.printers, printerId]);
  const template = useMemo(() => configuration.templates.find((item) => item.id === templateId) ?? null, [configuration.templates, templateId]);

  return { ...configuration, printerId, templateId, setPrinterId, setTemplateId, printer, template, loading, error, reload: load };
}
