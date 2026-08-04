/**
 * The on-disk cache.
 *
 * Caching is an optimisation, so the interesting behaviour is all failure
 * behaviour: an unwritable directory, a corrupted entry or a clock that jumped
 * must produce a miss, never an exception, because a scan that dies because
 * `~/.cache` is read-only is worse than a slow one.
 *
 * Every test points `DEAD_DEPS_CACHE_DIR` at a temporary directory — the class
 * reads the variable in its constructor, so it must be set before construction.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DiskCache, resolveCacheDir } from '../src/sources/cache.js';

const ONE_MS_IN_HOURS = 1 / 3_600_000;

let root: string;
let counter = 0;
let previous: string | undefined;

before(async () => {
  previous = process.env['DEAD_DEPS_CACHE_DIR'];
  root = await mkdtemp(join(tmpdir(), 'dead-deps-cache-'));
});

afterEach(() => {
  delete process.env['DEAD_DEPS_CACHE_DIR'];
});

after(async () => {
  if (previous === undefined) delete process.env['DEAD_DEPS_CACHE_DIR'];
  else process.env['DEAD_DEPS_CACHE_DIR'] = previous;
  await rm(root, { recursive: true, force: true });
});

/** A fresh cache directory, pointed at by the environment variable. */
function useCacheDir(): string {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  process.env['DEAD_DEPS_CACHE_DIR'] = dir;
  return dir;
}

/** Where `DiskCache` stores a key. Mirrors its sharding on purpose. */
function entryPath(dir: string, key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  return join(dir, digest.slice(0, 2), `${digest}.json`);
}

describe('resolveCacheDir', () => {
  test('DEAD_DEPS_CACHE_DIR wins', () => {
    const dir = useCacheDir();
    assert.equal(resolveCacheDir(), dir);
  });

  test('XDG_CACHE_HOME is used when no explicit directory is set', () => {
    const previousXdg = process.env['XDG_CACHE_HOME'];
    delete process.env['DEAD_DEPS_CACHE_DIR'];
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg');
    try {
      assert.equal(resolveCacheDir(), join(root, 'xdg', 'dead-deps'));
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousXdg;
    }
  });
});

describe('DiskCache', () => {
  test('round-trips a value', async () => {
    const dir = useCacheDir();
    const cache = new DiskCache(24, true);
    const value = { name: 'request', versions: ['2.88.2'], nested: { ok: true } };

    assert.equal(await cache.get('https://example.com/a'), null, 'a cold cache must miss');
    await cache.set('https://example.com/a', value);

    assert.deepEqual(await cache.get('https://example.com/a'), value);
    // A second instance reads what the first wrote: the cache is on disk, not
    // in the process.
    assert.deepEqual(await new DiskCache(24, true).get('https://example.com/a'), value);
    assert.equal(await cache.get('https://example.com/other'), null);

    const shards = await readdir(dir);
    assert.equal(shards.length, 1, 'entries are sharded by the first byte of the digest');
  });

  test('stores null and false without confusing them with a miss', async () => {
    useCacheDir();
    const cache = new DiskCache(24, true);

    await cache.set('k-false', false);
    assert.equal(await cache.get('k-false'), false);

    await cache.set('k-zero', 0);
    assert.equal(await cache.get('k-zero'), 0);
  });

  test('keys do not collide across similar URLs', async () => {
    useCacheDir();
    const cache = new DiskCache(24, true);

    await cache.set('https://example.com/a', 'first');
    await cache.set('https://example.com/a?x=1', 'second');

    assert.equal(await cache.get('https://example.com/a'), 'first');
    assert.equal(await cache.get('https://example.com/a?x=1'), 'second');
  });

  test('an expired entry is a miss', async () => {
    const dir = useCacheDir();
    await new DiskCache(24, true).set('stale-key', { cached: true });
    assert.deepEqual(await new DiskCache(24, true).get('stale-key'), { cached: true });

    // Same directory, a one-millisecond TTL.
    await delay(5);
    assert.equal(await new DiskCache(ONE_MS_IN_HOURS, true).get('stale-key'), null);

    // The entry is still on disk: it is its age that disqualified it, and a
    // longer-lived reader can still use it.
    assert.ok(existsSync(entryPath(dir, 'stale-key')));
    assert.deepEqual(await new DiskCache(24, true).get('stale-key'), { cached: true });
  });

  test('an entry written in the future is a miss, not an immortal one', async () => {
    const dir = useCacheDir();
    const cache = new DiskCache(24, true);

    // Let the cache create its own shard directory, then tamper with the entry
    // as a backwards clock jump would.
    await cache.set('future-key', 'original');
    await writeFile(
      entryPath(dir, 'future-key'),
      JSON.stringify({
        key: 'future-key',
        storedAt: new Date(Date.now() + 86_400_000).toISOString(),
        value: 'from the future',
      }),
      'utf8',
    );

    assert.equal(await cache.get('future-key'), null);
  });

  test('a zero or negative TTL disables the cache entirely', async () => {
    useCacheDir();
    for (const ttl of [0, -1, Number.NaN]) {
      const cache = new DiskCache(ttl, true);
      await cache.set('k', 'v');
      assert.equal(await cache.get('k'), null, `ttl ${ttl} should disable the cache`);
    }
  });

  test('a disabled cache never reads or writes', async () => {
    const dir = useCacheDir();
    const disabled = new DiskCache(24, false);

    await disabled.set('k', 'v');
    assert.equal(await disabled.get('k'), null);

    // Nothing was created on disk at all.
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
  });

  test('a corrupted entry degrades to a miss', async () => {
    const dir = useCacheDir();
    const cache = new DiskCache(24, true);
    await cache.set('corrupt-key', { real: true });

    await writeFile(entryPath(dir, 'corrupt-key'), '{ not json at all', 'utf8');
    assert.equal(await cache.get('corrupt-key'), null);
  });

  test('an entry that is not an envelope degrades to a miss', async () => {
    const dir = useCacheDir();
    const cache = new DiskCache(24, true);
    await cache.set('shape-key', { real: true });

    await writeFile(entryPath(dir, 'shape-key'), JSON.stringify({ value: 'no envelope' }), 'utf8');
    assert.equal(await cache.get('shape-key'), null);

    await writeFile(
      entryPath(dir, 'shape-key'),
      JSON.stringify({ key: 'shape-key', storedAt: 'not a date', value: 'x' }),
      'utf8',
    );
    assert.equal(await cache.get('shape-key'), null);
  });

  test('an unusable cache directory degrades instead of throwing', async () => {
    // A regular file where the cache directory should be: every mkdir under it
    // fails with ENOTDIR.
    counter += 1;
    const blocked = join(root, `blocked-${counter}`);
    await writeFile(blocked, 'not a directory', 'utf8');
    process.env['DEAD_DEPS_CACHE_DIR'] = blocked;

    const cache = new DiskCache(24, true);
    await cache.set('any-key', { value: 1 });
    assert.equal(await cache.get('any-key'), null);

    // And it stays quiet on every subsequent call rather than retrying loudly.
    await cache.set('another-key', { value: 2 });
    assert.equal(await cache.get('another-key'), null);
  });

  test('a value that cannot be serialised is skipped, not thrown over', async () => {
    useCacheDir();
    const cache = new DiskCache(24, true);

    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;

    await cache.set('cyclic-key', cyclic);
    assert.equal(await cache.get('cyclic-key'), null);
  });

  test('no temporary files are left behind', async () => {
    const dir = useCacheDir();
    const cache = new DiskCache(24, true);
    await cache.set('tidy-key', { a: 1 });

    const shard = (await readdir(dir))[0];
    assert.ok(shard !== undefined);
    const files = await readdir(join(dir, shard));
    assert.deepEqual(
      files.filter((file) => file.endsWith('.tmp')),
      [],
    );
  });
});
