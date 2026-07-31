/**
 * Logging that cannot corrupt the protocol.
 *
 * In stdio mode, **stdout carries JSON-RPC framing and nothing else**. A single
 * stray `console.log` desynchronises the stream and every MCP client reports an
 * opaque "failed to start" with no clue as to why. This module is the only
 * sanctioned way to emit diagnostics, and it always writes to stderr.
 *
 * As a backstop, `guardStdout()` replaces the console methods that would
 * otherwise reach stdout, so an accidental `console.log` in any dependency is
 * redirected rather than fatal.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function write(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (LEVELS[level] > threshold) return;
  const text = args
    .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
    .join(' ');
  process.stderr.write(`[network-mock ${level}] ${text}\n`);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...args: unknown[]): void => write('error', args),
  warn: (...args: unknown[]): void => write('warn', args),
  info: (...args: unknown[]): void => write('info', args),
  debug: (...args: unknown[]): void => write('debug', args),
};

/** Redirects console output away from stdout. Call before connecting a transport. */
export function guardStdout(): void {
  console.log = (...args: unknown[]) => write('info', args);
  console.info = (...args: unknown[]) => write('info', args);
  console.debug = (...args: unknown[]) => write('debug', args);
  console.warn = (...args: unknown[]) => write('warn', args);
  console.error = (...args: unknown[]) => write('error', args);
}
