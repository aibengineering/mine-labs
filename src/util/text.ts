/**
 * String formatting for things people read: run directory names
 * and elapsed times in the console.
 *
 * These exist so presentation choices are made once. `slugify` in particular is
 * load-bearing rather than cosmetic: it turns a scenario's free-text name into
 * a path segment, so it must always produce something non-empty and safe on
 * every platform.
 */

/** A scenario name reduced to a path-safe segment. Never returns an empty string. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "scenario";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
