import type { Metadata } from "next";
import { DM_Sans, Fraunces, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { ThemeToggle } from "@/components/news/ThemeToggle";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PositiveNews — Good things happening in the world",
  description:
    "A curated feed of constructive, solutions-focused and uplifting journalism from around the world.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${fraunces.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background">
        <header className="sticky top-0 z-50 border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-3">
            <img
              src="/news/logo.svg"
              alt=""
              aria-hidden
              width={28}
              height={28}
              className="select-none shrink-0"
            />
            <span className="font-heading font-semibold text-lg tracking-tight text-foreground">
              PositiveNews
            </span>
            <span className="hidden sm:inline text-xs text-muted-foreground ml-1 mt-0.5">
              Good things happening in the world
            </span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6">
          {children}
        </main>

        <footer className="border-t border-border/60 py-6 text-center text-xs text-muted-foreground">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4">
            <span>PositiveNews — aggregating constructive journalism</span>
            <span className="hidden sm:inline text-border">|</span>
            <nav className="flex items-center gap-3">
              <Link href="/privacy" className="hover:text-foreground transition-colors">
                Privacy Policy
              </Link>
              <span className="text-border">·</span>
              <Link href="/terms" className="hover:text-foreground transition-colors">
                Terms of Service
              </Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
