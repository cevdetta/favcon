import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

// A static site. Everything that touches an SVG runs in the visitor's tab - there is no
// endpoint to upload a mark to, because there is no server to receive it.
export default defineConfig({
  output: 'static',
  vite: {
    // lib/core.mjs lives above this directory: the site shares favcon's isomorphic half by
    // importing the file, not by copying it. Vite refuses to serve outside the project root in
    // dev unless told, and this is the one exception.
    server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
    // The WASM codecs are fetched, not bundled, so they stay out of the JS payload.
    optimizeDeps: { exclude: ['@jsquash/png', '@jsquash/oxipng', '@resvg/resvg-wasm'] },
  },
});
