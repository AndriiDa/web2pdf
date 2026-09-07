import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Web2PDF — Clean web pages as A4 PDFs',
  description:
    'Convert any public web page into a clean, properly paginated A4 PDF, with ads and popups removed.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
