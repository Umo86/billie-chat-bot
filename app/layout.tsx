import type { Metadata, Viewport } from "next";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { brandName } from "@/lib/config";

export const metadata: Metadata = {
  title: { default: brandName, template: `%s · ${brandName}` },
  description: "Chatbots, live handover and an email assistant for Media10 shows.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-dvh">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
