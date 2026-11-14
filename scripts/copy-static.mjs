// Copies non-TypeScript assets (dashboard static files) into dist/ after tsc.
import { cpSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'dashboard', 'static');
if (existsSync(src)) cpSync(src, join(root, 'dist', 'dashboard', 'static'), { recursive: true });
const cli = join(root, 'dist', 'cli', 'index.js');
if (existsSync(cli)) chmodSync(cli, 0o755);
