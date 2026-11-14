/**
 * File logger. NEVER writes to stdout (stdout is the MCP stdio channel and hook context channel).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(file: string | null, component: string, level: LogLevel = (process.env.CATALYST_LOG_LEVEL as LogLevel) || 'info'): Logger {
  let dirReady = false;
  const write = (lvl: LogLevel, msg: string, data?: unknown) => {
    if (order[lvl] < order[level]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, c: component, msg, ...(data === undefined ? {} : { data: safe(data) }) }) + '\n';
    if (!file) {
      process.stderr.write(line);
      return;
    }
    try {
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true });
        dirReady = true;
      }
      appendFileSync(file, line);
    } catch {
      /* logging must never crash the process */
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

function safe(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack?.split('\n').slice(0, 5).join('\n') };
  return data;
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
