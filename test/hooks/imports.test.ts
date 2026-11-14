import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Runtime (not type-only) import specifiers of a TS source file. */
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs: string[] = [];
  const re = /^\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    if (m[4]) {
      specs.push(m[4]);
      continue;
    }
    if (m[1]) continue; // import type … / export type …
    const clause = (m[2] ?? '').trim();
    const named = /^\{([^}]*)\}$/.exec(clause)?.[1];
    if (named !== undefined && named.split(',').every((n) => !n.trim() || n.trim().startsWith('type '))) continue;
    specs.push(m[3]!);
  }
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]!);
  return specs;
}

/** External specifiers reachable from `entry` through relative runtime imports. */
function externalClosure(entry: string): string[] {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else external.add(spec);
    }
  };
  visit(entry);
  return [...external];
}

const forbidden = (specs: string[]) => specs.filter((s) => s === 'zod' || s.startsWith('zod/') || s.startsWith('@modelcontextprotocol') || s === 'node:sqlite');

describe('hook entry import boundary', () => {
  it('does not (transitively) import zod, the MCP SDK or node:sqlite', () => {
    const ext = externalClosure(resolve(root, 'src/hooks/entry.ts'));
    expect(ext).toContain('node:http'); // via src/client — proves the walk follows imports
    expect(forbidden(ext)).toEqual([]);
  });

  it('scanner detects forbidden imports (sanity check on the MCP adapter)', () => {
    expect(forbidden(externalClosure(resolve(root, 'src/mcp/server.ts'))).length).toBeGreaterThan(0);
  });
});
