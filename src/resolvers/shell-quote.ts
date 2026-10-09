// The one shell-quoting helper for commands this vessel builds as text for a shell (the tools shell runs bash -c).
// A leaf module: feature-compose.ts re-exports it, and super-repo-checkout.ts (which feature-compose.ts imports)
// uses it without an import cycle.

/** POSIX single-quoted shell word: bash reads every byte between the quotes literally. */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
