/**
 * The browser-tab icon: the sun over two waves, in the brand colours of config/brand.json.
 * The wordmark stays text (the prototype has no logo); this is only the small mark a tab needs.
 */
import { tokenSets } from '../../scripts/lib/tokens.mjs';

export function renderFavicon(): string {
  const { light } = tokenSets();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <clipPath id="tile"><rect width="32" height="32" rx="7"/></clipPath>
  <g clip-path="url(#tile)">
    <rect width="32" height="32" fill="${light.sceneSky}"/>
    <circle cx="16" cy="14" r="6" fill="${light.sand}"/>
    <path d="M-2 19c4-3 7-3 11 0s7 3 11 0 7-3 11 0 3 1 3 1v14H-2z" fill="${light.accent}"/>
    <path d="M-2 25c4-3 7-3 11 0s7 3 11 0 7-3 11 0 3 1 3 1v8H-2z" fill="${light.primary}"/>
  </g>
</svg>
`;
}
