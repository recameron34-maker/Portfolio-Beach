// Build-time variables the app reads from import.meta.env (Vite exposes only the VITE_ prefix).
interface ImportMetaEnv {
  /** 'true' in preview builds: recorded synthetic API responses and hash routing (scripts/build-preview.mjs). */
  readonly VITE_PB_PREVIEW?: string;
}
