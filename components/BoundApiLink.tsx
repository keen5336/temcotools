"use client";
import type { AnchorHTMLAttributes } from "react";
import { boundApiHref } from "@/lib/ui-context/shared";
import { useUiContext } from "./UiContextBoundary";

// Native downloads/JSON navigation cannot send fetch headers. Their GET-only
// query fingerprint has no authority without the matching cookie and domain
// checks; private API responses also suppress referrers and caching.
export default function BoundApiLink({ href, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string }) {
  const context = useUiContext();
  return <a {...props} href={boundApiHref(href, context)} referrerPolicy="no-referrer" />;
}
