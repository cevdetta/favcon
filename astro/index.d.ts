// Hand-written, because the options are a smaller surface than the CLI's argv by design,
// and a generated type would describe the argv shape instead.

import type { AstroIntegration } from 'astro';

export interface FavconOptions {
  /** The mark, relative to the project root. Default: `src/logo.svg`. */
  input?: string;
  /** Padded PNG sizes, the manifest's "any maskable" icons. A real array: the CLI's string form exists only because argv is strings. Default: `[192, 512]`. */
  sizes?: number[];
  /** Palette size, 2-256. Default: 256, a ceiling: a flat mark uses only the colours it has. */
  colors?: number;
  /** Ground of the padded icons. `null` keeps the set transparent and unpadded, declared `"any"` only. Default: `#000000`. */
  bg?: string | null;
  /** Margin of each padded icon, as a percentage per side. `'auto'` measures the mark's own extent and snaps it to whole pixels; a number overrides it. Default: `'auto'`. */
  padding?: number | 'auto';
  /** CSS custom properties, with or without the leading `--`. */
  vars?: Record<string, string | number>;
  /** `false` builds logo.svg static too, so it equals icon.svg. Default: `true`. */
  animation?: boolean;
  /**
   * `true` writes an icons-only site.webmanifest. An object is merged in ahead of the
   * icons. The CLI cannot know your app's name; an integration can.
   */
  manifest?: boolean | Record<string, unknown>;
  /**
   * What to build while the dev server runs.
   * `'fast'` (default) is one 256 px size with zopfli off: under a second instead of ~30 s,
   * and not the production bytes, by design. `'full'` builds the real set. `'skip'`
   * builds nothing.
   */
  dev?: 'fast' | 'skip' | 'full';
  /**
   * `'inject'` (default) splices the tags before `</head>`, skipping any page that already
   * declares an icon. `'component'` leaves it to `favcon/astro/Head.astro`. `false` logs the
   * block for you to paste.
   */
  head?: 'inject' | 'component' | false;
}

export default function favcon(options?: FavconOptions): AstroIntegration;
