import { Geist_Mono, Geist, Outfit } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { baseUrl, createMetadata } from "@/utils/metadata";
import {
  StoreInitializer,
  BackgroundUploadRunner,
} from "@/components/store-initializer";
import { QueryProvider } from "@/components/query-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { buildStampScript } from "@/features/editor/utils/build-stamp";

import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata = createMetadata({
  title: {
    template: "%s | Combo",
    default: "Combo",
  },
  description: "AI Video generator for the next gen web.",
  metadataBase: baseUrl,
});

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Runs before the app bundle — and therefore before any zustand persist
            store hydrates — so a build change drops stale localStorage caches
            instead of rehydrating a shape the new code no longer understands.
            See build-stamp.ts for why a plain reload can't fix that. */}
        <script
          dangerouslySetInnerHTML={{
            __html: buildStampScript(process.env.NEXT_PUBLIC_BUILD_STAMP || ""),
          }}
        />
      </head>
      <body
        className={`${geistMono.variable} ${geist.variable} ${outfit.variable} antialiased font-sans bg-muted`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          <QueryProvider>
            {children}
            <StoreInitializer />
            <BackgroundUploadRunner />
            <Toaster />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
