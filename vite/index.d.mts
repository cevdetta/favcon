// Hand-written, like bin/favcon.d.mts: the plugin takes the config keys minus `out`.
import type { Plugin } from 'vite';
import type { FavconConfig } from '../bin/favcon.d.mts';

/** favcon.config.* keys, minus `out`: Vite's build.outDir decides where the files go. */
export type FavconViteOptions = Omit<FavconConfig, 'out'>;

/**
 * The favicon set as a Vite plugin. Dev serves it from memory (fast mode); a build emits it
 * at the output root and links it in index.html. Options win over favcon.config.* in the
 * Vite root. Default input: `src/logo.svg`.
 */
export default function favcon(options?: FavconViteOptions): Plugin;

export interface ManifestIcon { src: string; sizes: string; type: string; purpose?: string }

/** The icon entries favcon's manifest lists, for vite-plugin-pwa's `manifest.icons`. */
export function favconIcons(options?: Pick<FavconConfig, 'sizes' | 'bg' | 'base'>): ManifestIcon[];
