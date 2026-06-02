// Build-time DEBUG flag. Vite replaces import.meta.env.DEV at build time.
const DEBUG = typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

export function log(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

export function warn(...args: unknown[]): void {
  if (DEBUG) console.warn(...args);
  // Always surface errors though
}

export function error(...args: unknown[]): void {
  console.error(...args);
}
