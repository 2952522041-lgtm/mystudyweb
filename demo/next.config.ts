import type { NextConfig } from 'next';

// `pnpm pages` builds a fully static export for hosts that serve plain files
// (e.g. GitHub Pages); the default build targets Cloudflare Workers.
const nextConfig: NextConfig = process.env.VINEXT_EXPORT
  ? { output: 'export' }
  : {};

export default nextConfig;
