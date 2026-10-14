import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopNav } from "@/components/layout/TopNav";
import { AppProviders } from "@/components/providers/AppProviders";

// Cinzel SemiBold (OFL, fonts/OFL-Cinzel.txt): the wordmark's face, used for page titles.
const cinzel = localFont({ src: "./fonts/Cinzel-SemiBold.woff", weight: "600", variable: "--font-cinzel", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "Moatpad · every coin gets a moat", template: "%s · Moatpad" },
  description: "Every coin gets a moat. Launch on pump.fun where creator fees fund an on-chain floor vault and pay long-term holders every 2 minutes.",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${cinzel.variable}`}>
      <body className="font-sans antialiased">
        <AppProviders>
          <TopNav />
          <div className="mx-auto flex max-w-[1600px]">
            <Sidebar />
            <main className="min-w-0 flex-1 px-4 pt-5 pb-28 md:pb-12 lg:px-6">{children}</main>
          </div>
          <MobileTabBar />
        </AppProviders>
      </body>
    </html>
  );
}
