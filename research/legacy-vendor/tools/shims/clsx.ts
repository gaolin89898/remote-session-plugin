/** Minimal clsx-compatible shim used by vendored official components. */
export default function clsx(...args: unknown[]): string {
  const out: string[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === 'string' || typeof arg === 'number') out.push(String(arg));
    else if (Array.isArray(arg)) out.push(clsx(...arg));
    else if (typeof arg === 'object') {
      for (const [key, value] of Object.entries(arg as Record<string, unknown>)) {
        if (value) out.push(key);
      }
    }
  }
  return out.join(' ');
}
