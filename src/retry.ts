/**
 * Retry with exponential backoff for the transient failures a long scrape runs
 * into: rate limits, 5xx blips, and dropped sockets. Anything that won't improve
 * by trying again — 401/403/404, or an SSO login page where JSON should be — is
 * rethrown immediately so the run still fails fast with a useful message.
 */

import { CONFIG } from "../config.js";
import { log } from "./logger.js";

/** Marks a failure as worth another attempt (rate limit, 5xx, socket drop). */
export class TransientError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "TransientError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Statuses worth retrying: rate limiting and server-side blips. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

/**
 * Playwright surfaces dropped sockets and timeouts as plain Errors, so they have
 * to be spotted by message. Deliberately narrow: matching too eagerly would turn
 * a permanent failure into three slow ones.
 */
const TRANSIENT_MESSAGES = [
  "econnreset",
  "econnrefused",
  "econnaborted",
  "etimedout",
  "epipe",
  "eai_again",
  "socket hang up",
  "timeout exceeded",
  "timed out",
];

function looksTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_MESSAGES.some((m) => msg.includes(m));
}

/** A Retry-After header (seconds, or an HTTP date) as milliseconds. */
export function parseRetryAfter(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures up to `CONFIG.retry.attempts` times.
 * `label` only shows up in the retry log line, so make it identify the request.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs, maxRetryAfterMs } = CONFIG.retry;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const transient = err instanceof TransientError || looksTransient(err);
      if (!transient || attempt >= attempts) throw err;

      // Honour the server's own Retry-After when it sent one (capped, so a wild
      // value can't stall the whole run); otherwise back off exponentially with
      // jitter to avoid lockstep retries.
      const hinted = err instanceof TransientError ? err.retryAfterMs : undefined;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const wait =
        hinted !== undefined ? Math.min(hinted, maxRetryAfterMs) : backoff + Math.random() * backoff * 0.3;

      log.warn(
        `[retry] ${label}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)} — ` +
          `attempt ${attempt}/${attempts}, retrying in ${(wait / 1000).toFixed(1)}s`,
      );
      await sleep(wait);
    }
  }
}
