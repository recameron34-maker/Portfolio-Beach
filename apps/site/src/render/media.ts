/**
 * The media the scripts generate (media/, never committed) as the build reads it: the three
 * manifests written by scripts/capture-screens.mjs, record-demos.mjs and make-brochures.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Screenshot {
  name: string;
  width: number;
  height: number;
  file: string;
  file2x: string;
}

export interface DemoVideo {
  name: string;
  title: string;
  summary: string;
  file: string;
  poster: string;
  width: number;
  height: number;
  seconds: number;
  bytes: number;
  steps: { at: number; text: string }[];
}

export interface Brochure {
  name: string;
  title: string;
  description: string;
  file: string;
  cover: string;
  pages: number;
  bytes: number;
}

export interface Media {
  screens: Map<string, Screenshot>;
  videos: DemoVideo[];
  brochures: Brochure[];
}

function manifest(mediaDir: string, kind: string, script: string): Record<string, unknown> {
  const file = join(mediaDir, kind, 'manifest.json');
  if (!existsSync(file))
    throw new Error(
      `the site's media is not generated: ${file} is missing. Run "node scripts/${script}" in apps/site, or "pnpm --filter @pb/site build" to make everything in order.`,
    );
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${file} is not a manifest`);
  return parsed as Record<string, unknown>;
}

/** Reads the three manifests; fails with the command to run when one is missing. */
export function readMedia(mediaDir: string): Media {
  const screens = manifest(mediaDir, 'screens', 'capture-screens.mjs').shots as Screenshot[];
  const videos = manifest(mediaDir, 'videos', 'record-demos.mjs').videos as DemoVideo[];
  const brochures = manifest(mediaDir, 'brochures', 'make-brochures.mjs').brochures as Brochure[];
  return { screens: new Map(screens.map((s) => [s.name, s])), videos, brochures };
}

/** "58 seconds" or "1 min 12 s". */
export function lengthText(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} seconds`;
  const rest = whole % 60;
  return rest === 0 ? `${whole / 60} min` : `${Math.floor(whole / 60)} min ${rest} s`;
}

/** "4.9 MB" or "820 KB". */
export function sizeText(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
