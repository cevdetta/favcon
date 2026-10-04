import { defineConfig } from 'astro/config';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// A static site on Cloudflare Pages, built from main by the Pages dashboard: no adapter, no
// deploy workflow. Everything that touches an SVG runs in the visitor's tab: there is no
// endpoint to upload a mark to, because there is no server to receive it.
export default defineConfig({
  site: 'https://favcon.cevdet.ch',
  output: 'static',
  // Cloudflare Pages canonicalises a directory index as /foo/ and 308s /foo to it. Emitting
  // /foo.html instead serves the slash-free URL with no redirect, which is Cloudflare's own
  // advice for this case, and the same pair deadhead.cevdet.ch uses.
  trailingSlash: 'never',
  build: {
    format: 'file',
    // One page and one small stylesheet, so there is no second page to share a cached file
    // with: inlining removes the only render-blocking request. 'always', not the default
    // 'auto', so a stylesheet that grows past 4 KB does not turn back into a request unnoticed.
    inlineStylesheets: 'always',
  },
  integrations: [
    {
      name: 'favcon-host',
      hooks: {
        // Hashed build assets never change under the same name; everything else is revalidated.
        'astro:build:done': async ({ dir }) => {
          await writeFile(new URL('_headers', dir), '/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n');
        },
      },
    },
  ],
  vite: {
    // lib/core.mjs lives above this directory: the site shares favcon's isomorphic half by
    // importing the file, not by copying it. Vite refuses to serve outside the project root in
    // dev unless told, and this is the one exception.
    server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
    // The WASM codecs are fetched, not bundled, so they stay out of the JS payload.
    optimizeDeps: { exclude: ['@jsquash/png', '@jsquash/oxipng', '@resvg/resvg-wasm'] },
  },
});
