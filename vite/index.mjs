// favcon/vite: the favicon set as a Vite plugin. In dev it is built on the first request for
// an icon and served from memory; in a build it is emitted at the output root. Nothing is
// written to public/, and a file there with a name favcon emits is never shadowed.
import { normaliseOptions } from '../lib/config.mjs';
import { manifestIcons } from '../lib/core.mjs';

/**
 * The icon entries favcon's manifest would list, for vite-plugin-pwa's `manifest.icons`.
 * Synchronous, because vite.config runs before any build; pass the sizes, bg and base the
 * favcon plugin uses. vite-plugin-pwa offers no public API to set them from another plugin.
 */
export const favconIcons = ({ sizes, bg, base } = {}) => {
  const o = normaliseOptions({ sizes, bg, base });
  return manifestIcons({ sizes: o.sizes, base: o.base, purpose: o.bg === null ? null : 'any maskable' });
};
