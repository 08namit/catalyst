import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('cli entry', () => {
  it('statically imports only node built-ins and light core modules (hooks must start fast)', () => {
    const src = readFileSync(new URL('../../src/cli/index.ts', import.meta.url), 'utf8');
    const staticImports = [...src.matchAll(/^import (?!type )[^;]*? from '([^']+)';/gm)].map((m) => m[1]);
    for (const spec of staticImports) {
      expect(spec === '../core/config.js' || spec === '../core/paths.js' || spec!.startsWith('node:'), `static import ${spec}`).toBe(true);
    }
  });
});
