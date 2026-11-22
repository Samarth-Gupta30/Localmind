import { env } from '../config/env';
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const SENSITIVE_KEY_RE = /token|secret|password|cookie|authorization|sessionid|apikey/i;
const SENSITIVE_STRING_PATTERNS: Array<[RegExp, string]> = [
  [/(localmind_agent_session=)([^;\s"']+)/gi, '$1[REDACTED]'],
  [/(lm_agent_sid=)([^;\s"']+)/gi, '$1[REDACTED]'],
  [/(approvalToken["'=:\s]+)([A-Za-z0-9\-._~+/=]+)/gi, '$1[REDACTED]'],
  [/(sessionId["'=:\s]+)([A-Za-z0-9\-._~+/=]+)/gi, '$1[REDACTED]'],
  [/(Bearer\s+)([A-Za-z0-9\-._~+/=]+)/gi, '$1[REDACTED]'],
];

function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SENSITIVE_STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }

  return value;
}

class Logger {
  private formatTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  private formatMessage(level: LogLevel, context: string, message: string): string {
    const safeMessage = redactString(message);
    return `[${this.formatTimestamp()}] [${level.padEnd(5)}] [${context}] ${safeMessage}`;
  }

  public debug(context: string, message: string, ...args: unknown[]): void {
    if (!env.isProduction) {
      console.debug(
        this.formatMessage('DEBUG', context, message),
        ...args.map((a) => redactValue(a))
      );
    }
  }

  public info(context: string, message: string, ...args: unknown[]): void {
    console.log(
      this.formatMessage('INFO', context, message),
      ...args.map((a) => redactValue(a))
    );
  }

  public warn(context: string, message: string, ...args: unknown[]): void {
    console.warn(
      this.formatMessage('WARN', context, message),
      ...args.map((a) => redactValue(a))
    );
  }

  public error(context: string, message: string, error?: unknown): void {
    console.error(this.formatMessage('ERROR', context, message));
    if (error) {
      if (error instanceof Error && error.stack) {
        console.error(redactString(error.stack));
      } else {
        console.error(redactValue(error));
      }
    }
  }
}

export const logger = new Logger();