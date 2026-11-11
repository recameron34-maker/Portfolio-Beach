/**
 * A small HTML builder for the build step: the site's pages are rendered to static markup when
 * Vite builds (vite.config.ts), never in the browser. Interpolated text is escaped unless it is
 * markup made by this builder.
 */
export class Markup {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Part = string | number | Markup | readonly Part[] | null | undefined | false;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return '';
  if (part instanceof Markup) return part.value;
  if (typeof part === 'number') return String(part);
  if (typeof part === 'string') return escapeHtml(part);
  return part.map(render).join('');
}

/** A tagged template: the literal parts are markup, the interpolated parts are escaped text or nested markup. */
export function html(strings: TemplateStringsArray, ...parts: Part[]): Markup {
  let out = strings[0] ?? '';
  parts.forEach((part, i) => {
    out += render(part) + (strings[i + 1] ?? '');
  });
  return new Markup(out);
}

/** Markup written by hand elsewhere in the build (an SVG, a stylesheet): passed through as it is. */
export function trusted(value: string): Markup {
  return new Markup(value);
}
