import type { Metadata } from 'next';

import 'katex/dist/katex.min.css';
import './globals.css';

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://yeyu-pdf-reader-demo.nifty-boar-6348.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: '页语｜本地课程知识库与 PDF AI 阅读器',
  description:
    '把多份 PDF 组织为本地课程知识库，生成带来源的总结与脑图，并随页翻译或向 AI 提问。',
  openGraph: {
    title: '页语｜本地课程知识库与 PDF AI 阅读器',
    description: '课程知识有出处，阅读到哪一页，译文和视觉答疑就跟到哪一页。',
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
    title: '页语｜本地课程知识库与 PDF AI 阅读器',
    description: '课程知识有出处，阅读到哪一页，译文和视觉答疑就跟到哪一页。',
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
