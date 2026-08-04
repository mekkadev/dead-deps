/**
 * On-disk response cache.
 *
 * Caching is strictly an optimisation here: a read-only home directory, a full
 * disk or a corrupted entry must degrade to "no cache" and never interrupt a
 * scan. Every filesystem operation in this file is therefore swallowed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CacheEnvelope {
  key: string;
  /** ISO-8601 timestamp of when the value was written. */
  storedAt: string;
  value: unknown;
}

const MS_PER_HOUR = 3_600_000;

function firstNonEmpty(...candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * `DEAD_DEPS_CACHE_DIR` wins, then the XDG location, then the conventional
 * `~/.cache` fallback.
 */
export function resolveCacheDir(): string {
  const explicit = firstNonEmpty(process.env['DEAD_DEPS_CACHE_DIR']);
  if (explicit !== null) return explicit;

  const xdg = firstNonEmpty(process.env['XDG_CACHE_HOME']);
  if (xdg !== null) return join(xdg, 'dead-deps');

  return join(homedir(), '.cache', 'dead-deps');
}

function isEnvelope(value: unknown): value is CacheEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['key'] === 'string' && typeof record['storedAt'] === 'string' && 'value' in record;
}

export class DiskCache {
  private readonly ttlMs: number;
  private readonly enabled: boolean;
  private readonly dir: string;
  /** Shard directories already created (or attempted) in this process. */
  private readonly ensured = new Set<string>();
  /** Set once a write fails hard, so we stop retrying on every package. */
  private writable = true;

  constructor(ttlHours: number, enabled: boolean) {
    this.ttlMs = Number.isFinite(ttlHours) ? ttlHours * MS_PER_HOUR : 0;
    this.enabled = enabled && this.ttlMs > 0;
    this.dir = resolveCacheDir();
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.enabled) return null;

    let raw: string;
    try {
      raw = await readFile(this.pathFor(key), 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isEnvelope(parsed)) return null;

    const storedAt = Date.parse(parsed.storedAt);
    if (Number.isNaN(storedAt)) return null;
    // A clock that jumped backwards would otherwise make entries look fresh
    // forever; treat future timestamps as expired.
    const age = Date.now() - storedAt;
    if (age < 0 || age > this.ttlMs) return null;

    return parsed.value as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.enabled || !this.writable) return;

    const envelope: CacheEnvelope = { key, storedAt: new Date().toISOString(), value };
    let body: string;
    try {
      body = JSON.stringify(envelope);
    } catch {
      // Non-serialisable value (cycles, BigInt). Nothing to cache.
      return;
    }

    const target = this.pathFor(key);
    const shard = join(this.dir, this.shardFor(key));
    if (!(await this.ensureDir(shard))) return;

    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = `${target}.${process.pid.toString(36)}${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, target);
    } catch {
      this.writable = false;
      try {
        await unlink(tmp);
      } catch {
        /* the temp file may never have been created */
      }
    }
  }

  private shardFor(key: string): string {
    return this.digest(key).slice(0, 2);
  }

  private pathFor(key: string): string {
    const digest = this.digest(key);
    return join(this.dir, digest.slice(0, 2), `${digest}.json`);
  }

  private digest(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('hex');
  }

  private async ensureDir(dir: string): Promise<boolean> {
    if (this.ensured.has(dir)) return true;
    try {
      await mkdir(dir, { recursive: true });
      this.ensured.add(dir);
      return true;
    } catch {
      this.writable = false;
      return false;
    }
  }
}
