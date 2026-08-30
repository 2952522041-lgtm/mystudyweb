import type { Metadata } from 'next';

import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: '页语｜PDF 随页翻译阅读器',
  description: '导入 PDF，阅读到哪一页，译文就跟到哪一页。',
  openGraph: {
    title: '页语｜PDF 随页翻译阅读器',
    description: '阅读到哪一页，译文就跟到哪一页。',
    images: [
      {
        url: '/og.png',
        width: 1672,
        height: 941,
        alt: '页语：PDF 原文与译文随页对照阅读',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: '页语｜PDF 随页翻译阅读器',
    description: '阅读到哪一页，译文就跟到哪一页。',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
