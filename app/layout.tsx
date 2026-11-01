import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEMES } from "@/lib/themes";
import { getSession } from "@/lib/auth";
import LabelRelayProvider from "@/components/labels/LabelRelayProvider";
import ApiRelayLease from "@/components/api-relay/ApiRelayLease";
import SessionActivity from "@/app/account/security/SessionActivity";
import FavoritesProvider from "@/components/tools/FavoritesProvider";
import { pilotPolicy } from "@/scripts/pilot-policy.mjs";
import UiContextBoundary from "@/components/UiContextBoundary";
import { createUiContext } from "@/lib/auth/ui-context";
import { uiContextBootstrap } from "@/lib/ui-context/bootstrap";

export const metadata: Metadata = {
  title: "TemcoTools",
  description: "Internal warehouse operations tools",
};

// Intentionally minified: this script runs inline before React hydrates to prevent
// flash of unstyled content. Extra bytes here delay first paint.
// The theme list is derived from THEMES so both stay in sync automatically.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('temco_theme');if(${JSON.stringify([...THEMES])}.indexOf(t)>-1)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  const policy = pilotPolicy();
  const userId = session.isActive && session.userId ? session.userId : null;
  const uiContext = userId ? createUiContext(session) : null;
  return (
    <html lang="en" data-theme="light" data-temco-pilot={policy.isolated ? policy.mode : undefined} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script id="temco-ui-context-bootstrap" dangerouslySetInnerHTML={{ __html: uiContextBootstrap(uiContext) }} />
      </head>
      <body className="antialiased">
        {policy.isolated && <aside role="status" className="bg-warning text-warning-content p-3 text-center text-sm">Isolated v2 pilot — named DMP reads and private exports. Live MARS actions and printing are disabled. Official finals remain unqualified.</aside>}
        <ThemeProvider><UiContextBoundary context={uiContext}><FavoritesProvider key={uiContext || "anonymous"} userId={userId} role={userId ? session.role : "user"} capabilities={session.capabilities ?? []}><SessionActivity userId={userId} /><ApiRelayLease userId={userId} /><LabelRelayProvider userId={userId}>{children}</LabelRelayProvider></FavoritesProvider></UiContextBoundary></ThemeProvider>
      </body>
    </html>
  );
}
