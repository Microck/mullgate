import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import type { Metadata } from 'next';
import { Open_Sans, Source_Sans_3 } from 'next/font/google';
import { ThemeProvider } from 'next-themes';

const openSans = Open_Sans({
  subsets: ['latin'],
  variable: '--font-mullvad-body',
});

const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  variable: '--font-mullvad-heading',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://mullgate.dev'),
  title: {
    default: 'Mullgate Docs',
    template: '%s | Mullgate Docs',
  },
  description:
    'Documentation for Mullgate, a privacy-focused proxy and multi-exit gateway built around Mullvad-backed routing patterns.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${openSans.variable} ${sourceSans.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableColorScheme
          enableSystem
        >
          <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
