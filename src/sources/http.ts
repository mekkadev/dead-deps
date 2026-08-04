/**
 * The single outbound HTTP path for the whole tool.
 *
 * Everything upstream-facing goes through `HttpClient.getJson`, which is
 * deliberately total: it returns `null` rather than throwing, so one dead
 * package can never abort a scan of two hundred.
 */

import { createRequire } from 'node:module';
import { DiskCache } from './cache.js';

export interface HttpClientOptions {
  contact: string | null;
  cacheTtlHours: number;
  noCache: boolean;
  concurrency: number;
}

export interface HttpStats {
  cacheHits: number;
  requests: number;
  errors: number;
}

const REQUEST_TIMEOUT_MS = 20_000;
/** Waits before retry 1, 2 and 3. The length of this array is the retry budget. */
const BACKOFF_MS = [500, 1_000, 2_000] as const;
const MAX_RETRY_AFTER_MS = 10_000;
const REPO_URL = 'https://github.com/mekkadev/dead-deps';

function readVersion(): string {
  try {
    // Resolves to the package root from both `src/sources/` and `dist/sources/`.
    const require = createRequire(import.meta.url);
    const pkg: unknown = require('../../package.json');
    if (typeof pkg === 'object' && pkg !== null) {
      const version = (pkg as Record<string, unknown>)['version'];
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    /* published layouts may not ship package.json next to dist/ */
  }
  return '0.0.0';
}

const VERSION = readVersion();

export function userAgent(contact: string | null): string {
  const base = `dead-deps/${VERSION} (+${REPO_URL})`;
  const trimmed = contact?.trim();
  return trimmed ? `${base} ${trimmed}` : base;
}

function isEcosystemsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'ecosyste.ms' || host.endsWith('.ecosyste.ms');
}

/**
 * ecosyste.ms routes requests carrying a `mailto` into its polite pool, which
 * is both faster and the neighbourly thing to do.
 */
export function applyContact(url: string, contact: string | null): string {
  const trimmed = contact?.trim();
  if (!trimmed) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!isEcosystemsHost(parsed.hostname)) return url;
  if (parsed.searchParams.has('mailto')) return url;

  parsed.searchParams.set('mailto', trimmed);
  return parsed.toString();
}

/** Fixed-size gate over in-flight requests. Slots are handed to waiters directly. */
class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both appear in the wild. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value.length === 0) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const delta = at - Date.now();
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

function backoffFor(attempt: number): number {
  const base = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 2_000;
  // Full-width jitter on the top third keeps a burst of packages from
  // re-hitting the origin in lockstep.
  return Math.round(base + Math.random() * base * 0.33);
}

/** Free the socket promptly on responses whose body we are not going to read. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed or errored */
  }
}

export class HttpClient {
  readonly stats: HttpStats = { cacheHits: 0, requests: 0, errors: 0 };

  private readonly contact: string | null;
  private readonly cache: DiskCache;
  private readonly gate: Semaphore;
  /** Coalesces concurrent callers asking for the same URL. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(opts: HttpClientOptions) {
    this.contact = opts.contact;
    this.cache = new DiskCache(opts.cacheTtlHours, !opts.noCache);
    this.gate = new Semaphore(opts.concurrency);
  }

  async getJson<T>(url: string): Promise<T | null> {
    const cached = await this.cache.get<T>(url);
    if (cached !== null) {
      this.stats.cacheHits += 1;
      return cached;
    }

    const existing = this.inFlight.get(url);
    if (existing) return (await existing) as T | null;

    const pending = this.fetchJson(url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, pending);
    return (await pending) as T | null;
  }

  private async fetchJson(url: string): Promise<unknown> {
    if (!URL.canParse(url)) {
      // A malformed URL fails identically every time; do not burn the budget.
      this.stats.errors += 1;
      return null;
    }

    const target = applyContact(url, this.contact);
    const headers = {
      accept: 'application/json',
      'user-agent': userAgent(this.contact),
    };

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.attempt(target, headers);

      if (outcome.kind === 'ok') {
        await this.cache.set(url, outcome.value);
        return outcome.value;
      }
      if (outcome.kind === 'not-found') return null;
      if (outcome.kind === 'fatal' || attempt >= BACKOFF_MS.length) {
        this.stats.errors += 1;
        return null;
      }

      await sleep(outcome.retryAfterMs ?? backoffFor(attempt));
    }
  }

  private async attempt(
    target: string,
    headers: Record<string, string>,
  ): Promise<
    | { kind: 'ok'; value: unknown }
    | { kind: 'not-found' }
    | { kind: 'fatal' }
    | { kind: 'retry'; retryAfterMs: number | null }
  > {
    await this.gate.acquire();
    try {
      this.stats.requests += 1;

      let res: Response;
      try {
        res = await fetch(target, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // DNS failure, connection reset, timeout: all worth another go.
        return { kind: 'retry', retryAfterMs: null };
      }

      if (res.status === 404) {
        await discard(res);
        return { kind: 'not-found' };
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        await discard(res);
        return { kind: 'retry', retryAfterMs };
      }

      if (!res.ok) {
        // 400/401/403/etc: retrying an identical request will not help.
        await discard(res);
        return { kind: 'fatal' };
      }

      try {
        return { kind: 'ok', value: await res.json() };
      } catch {
        // Truncated or malformed body — often a mid-flight disconnect.
        return { kind: 'retry', retryAfterMs: null };
      }
    } finally {
      this.gate.release();
    }
  }
}
