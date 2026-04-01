/**
 * Structured JSON-line logger.
 *
 * Replaces scattered console.log('[module] ...') calls with machine-parseable
 * output that log aggregation tools (Datadog, Loki, CloudWatch) can ingest.
 *
 * Usage:
 *   import { log } from './logger.js';
 *   log('info', 'bot', 'PM tool dispatch', { tool: 'consult_agent', role: 'solidity-dev' });
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';

export function log(
  level: LogLevel,
  module: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
  };
  if (data) Object.assign(entry, { data });

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}
