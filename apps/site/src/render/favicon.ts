/**
 * The browser-tab icon: the product's mark (src/render/mark.ts), the ink square with its three
 * bars, in the brand colours of config/brand.json.
 */
import { tokenSets } from '../../scripts/lib/tokens.mjs';
import { markShapes } from './mark.js';

export function renderFavicon(): string {
  const { light } = tokenSets();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  ${markShapes({ tile: light.primary, bar: light.bg })}
</svg>
`;
}
