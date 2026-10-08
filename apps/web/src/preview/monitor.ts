/**
 * Page-level counters the probe reads (scripts/probe-preview.mjs): every request the recordings do
 * not cover, and how many requests the shim is answering, so a check can wait until the page is
 * quiet. They hold request keys and counts only, never response bodies.
 */
declare global {
  interface Window {
    /** Keys of requests the recordings did not cover in this page session. */
    __pbPreviewMisses?: string[];
    /** Requests the shim is answering now, and has answered since the page loaded. */
    __pbPreviewActivity?: { inflight: number; total: number };
  }
}

export function recordMiss(key: string): void {
  (window.__pbPreviewMisses ??= []).push(key);
}

export function requestStarted(): void {
  const activity = (window.__pbPreviewActivity ??= { inflight: 0, total: 0 });
  activity.inflight += 1;
  activity.total += 1;
}

export function requestFinished(): void {
  const activity = (window.__pbPreviewActivity ??= { inflight: 0, total: 0 });
  activity.inflight = Math.max(0, activity.inflight - 1);
}
