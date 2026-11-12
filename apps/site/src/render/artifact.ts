/**
 * The private preview build ("pnpm --filter @pb/site build:artifact"): the landing page as a
 * fragment that a host wraps in its own document, with its supporting files beside it. A fragment
 * has no doctype and no <html>, <head> or <body> tag. It holds, in this order: a <title>, the
 * stylesheet link and the inline token styles, the page's markup, then the script tag.
 *
 * What the document's head did is done elsewhere here: the stylesheet sets the page's own
 * background on <body>, the theme follows the data-theme attribute or the system setting through
 * the tokens (selectors on :root, which is the host's root element), and src/main.ts marks that
 * script runs. The demo is not part of this build: "Open the demo" goes to the address in
 * SITE_DEMO_URL.
 */
import { escapeHtml } from './html.js';

/** Tags a fragment must not hold: the host's document already has them. */
const DOCUMENT_TAGS = /<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>]/i;

function between(document: string, tag: string): string {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i').exec(document);
  const close = document.toLowerCase().lastIndexOf(`</${tag}>`);
  if (open === null || close === -1) throw new Error(`the built page has no <${tag}> element`);
  return document.slice(open.index + open[0].length, close);
}

/** Turns the document Vite built into the fragment, under the title given. */
export function toFragment(document: string, title: string): string {
  const head = between(document, 'head');
  const body = between(document, 'body');
  const links = head.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi) ?? [];
  const styles = head.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  const external = /<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/gi;
  const scripts = [...(head.match(external) ?? []), ...(body.match(external) ?? [])];
  // Scripts written into the document itself belong to the document; the fragment has none.
  const markup = body.replace(/<script\b[\s\S]*?<\/script>/gi, '').trim();
  if (links.length === 0 || styles.length === 0 || scripts.length === 0 || markup === '')
    throw new Error(
      `the built page is not what the fragment is made from: ${links.length} stylesheet links, ${styles.length} inline styles, ${scripts.length} scripts`,
    );
  // Vite writes "./assets/..."; the fragment names each file by the very path it is published
  // at, as publish.json lists it.
  const plain = (tag: string): string => tag.replace(/\b(href|src)="\.\//g, '$1="');
  const fragment = [
    `<title>${escapeHtml(title)}</title>`,
    ...links.map(plain),
    ...styles,
    markup,
    ...scripts.map(plain),
  ].join('\n');
  if (DOCUMENT_TAGS.test(fragment))
    throw new Error('the fragment holds a doctype or an <html>, <head> or <body> tag');
  return `${fragment}\n`;
}

/**
 * The address "Open the demo" goes to in this build, from SITE_DEMO_URL: an absolute http or
 * https address, or null when none was given (the page then carries no link to a demo).
 */
export function demoAddress(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('SITE_DEMO_URL is not an absolute address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('SITE_DEMO_URL must be an http or https address');
  return url.href;
}

/** Every relative URL the fragment names: what must sit beside it. */
export function fragmentFiles(fragment: string): string[] {
  const urls = new Set<string>();
  const add = (value: string): void => {
    const path = value.trim().replace(/^\.\//, '').split(/[?#]/)[0] ?? '';
    if (path !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(value.trim())) urls.add(path);
  };
  for (const match of fragment.matchAll(/\s(?:href|src|poster)="([^"#][^"]*)"/g))
    add(match[1] ?? '');
  for (const match of fragment.matchAll(/\ssrcset="([^"]*)"/g))
    for (const candidate of (match[1] ?? '').split(','))
      add(candidate.trim().split(/\s+/)[0] ?? '');
  return [...urls].sort();
}
