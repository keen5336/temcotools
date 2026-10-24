import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEMES } from "@/lib/themes";
import { getSession } from "@/lib/auth";
import LabelRelayProvider from "@/components/labels/LabelRelayProvider";
import ApiRelayLease from "@/components/api-relay/ApiRelayLease";

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
  const userId = session.isActive && session.userId ? session.userId : null;
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-before-interactive-script-outside-document */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="antialiased">
        <ThemeProvider><ApiRelayLease userId={userId} /><LabelRelayProvider userId={userId}>{children}</LabelRelayProvider></ThemeProvider>
      </body>
    </html>
  );
}
