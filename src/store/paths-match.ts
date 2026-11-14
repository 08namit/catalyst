/**
 * Path-scope overlap (advisory claim warnings). Globs are over-approximated by their directory prefix:
 * "src/api/**", "src/api/*.ts" and "src/api/" all mean "src/api". "", "*", "**" and "." mean the whole repo.
 */
function normalise(path: string): string {
  const segments = path
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((s, i) => !(s === '.' || (s === '' && i > 0)));
  const out: string[] = [];
  for (const s of segments) {
    if (/[*?[\]{}]/.test(s)) break;
    out.push(s);
  }
  return out.join('/');
}

function overlaps(a: string, b: string): boolean {
  if (a === b || a === '' || b === '') return true;
  return b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * Overlapping pairs between two path lists. Each entry is the shared path when both normalise to the same
 * path, otherwise "<a> ↔ <b>" (original spellings). Empty array = no overlap.
 */
export function pathsOverlap(a: string[], b: string[]): string[] {
  const result = new Set<string>();
  for (const x of a) {
    const nx = normalise(x);
    for (const y of b) {
      const ny = normalise(y);
      if (!overlaps(nx, ny)) continue;
      result.add(nx === ny ? nx || '*' : `${x} ↔ ${y}`);
    }
  }
  return [...result];
}
