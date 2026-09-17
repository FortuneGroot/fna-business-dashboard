import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://app.fortuneandautomations.com"),
  title: {
    default: "Fortune & Automations Business Dashboard",
    template: "%s · Fortune & Automations",
  },
  description:
    "Fortune & Automations Business Dashboard. Accounts, messaging, and live customer data are not connected in this shell.",
  applicationName: "Fortune & Automations Business Dashboard",
  authors: [{ name: "Fortune & Finance LLC" }],
  keywords: ["Fortune & Automations", "Business Dashboard", "Automation", "Websites", "Branding", "Systems"],
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon.svg" },
      { url: "/icon-192.jpg", sizes: "192x192", type: "image/jpeg" },
      { url: "/icon-512.jpg", sizes: "512x512", type: "image/jpeg" },
    ],
    apple: "/apple-touch-icon.jpg",
  },
  openGraph: {
    title: "Fortune & Automations Business Dashboard",
    description: "Client application shell. Live customer data is not connected yet.",
    url: "https://app.fortuneandautomations.com",
    siteName: "Fortune & Automations",
    type: "website",
    images: [{ url: "/og-image.png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#314258",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Source+Sans+3:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
