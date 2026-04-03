import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEMES } from "@/lib/themes";

export const metadata: Metadata = {
  title: "TemcoTools",
  description: "Internal warehouse operations tools",
};

// Intentionally minified: this script runs inline before React hydrates to prevent
// flash of unstyled content. Extra bytes here delay first paint.
// The theme list is derived from THEMES so both stay in sync automatically.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('temco_theme');if(${JSON.stringify([...THEMES])}.indexOf(t)>-1)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-before-interactive-script-outside-document */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
