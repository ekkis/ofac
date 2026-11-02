import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rm, stat, readdir, utimes } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import ofac from '../index.js';

const url = 'https://example.invalid/sdn.xml';
const modified = 'Sat, 31 Oct 2026 12:00:00 GMT';
const response = (status, body = '', headers = {}) => ({
  status, ok: status >= 200 && status < 300, body: Readable.from([body]),
  headers: { get: name => headers[name] || null }
});

async function fixture(t, replies) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ofac-http-'));
  const original = { ...ofac.opts }, calls = [];
  t.after(async () => { ofac.opts = original; await rm(dir, { recursive: true, force: true }); });
  ofac.config({ path: dir, force: true, fetch: async (source, options) => {
    calls.push({ source, headers: options.headers });
    const reply = replies.shift();
    assert.ok(reply, 'Unexpected HTTP request');
    return typeof reply === 'function' ? reply() : reply;
  } });
  return { dir, calls, file: path.join(dir, 'sdn.xml'), metadata: path.join(dir, 'sdn.xml.http.json') };
}

test('ETags persist across reloads and 304 reuses bytes and renews cache freshness', async t => {
  const f = await fixture(t, [response(200, 'original', { etag: '"v1"', 'last-modified': modified }), response(304)]);
  await ofac.fetch(url);
  assert.deepEqual(f.calls[0].headers, {});
  assert.equal((await stat(f.metadata)).mode & 0o777, 0o600);
  await utimes(f.file, new Date(0), new Date(0));
  // A newly loaded singleton has no in-memory validator state.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url), modulePath = require.resolve('../index.js');
  const originalModule = require.cache[modulePath];
  delete require.cache[modulePath];
  const restarted = require('../index.js');
  require.cache[modulePath] = originalModule;
  restarted.config({ ...ofac.opts });
  await restarted.fetch(url);
  assert.deepEqual(f.calls[1].headers, { 'If-None-Match': '"v1"' });
  assert.equal(await readFile(f.file, 'utf8'), 'original');
  assert.ok((await stat(f.file)).mtimeMs > Date.now() - 10000);
  restarted.config({ force: false, refreshInterval: 86400000 });
  await restarted.fetch(url);
  assert.equal(f.calls.length, 2);
});

test('Last-Modified is used when an ETag is unavailable', async t => {
  const f = await fixture(t, [response(200, 'original', { 'last-modified': modified }), response(304)]);
  await ofac.fetch(url); await ofac.fetch(url);
  assert.deepEqual(f.calls[1].headers, { 'If-Modified-Since': modified });
});

test('changed content replaces cached bytes and validators; missing validators remove old ones', async t => {
  const f = await fixture(t, [response(200, 'old', { etag: '"v1"' }), response(200, 'new', { etag: '"v2"' }),
    response(200, 'without validators'), response(200, 'again')]);
  await ofac.fetch(url); await ofac.fetch(url);
  assert.equal(await readFile(f.file, 'utf8'), 'new');
  assert.equal(JSON.parse(await readFile(f.metadata)).etag, '"v2"');
  await ofac.fetch(url);
  assert.deepEqual(f.calls[2].headers, { 'If-None-Match': '"v2"' });
  await ofac.fetch(url);
  assert.deepEqual(f.calls[3].headers, {});
});

test('missing, corrupted or source-mismatched cache never sends old validators', async t => {
  const f = await fixture(t, Array.from({ length: 6 }, () => response(200, 'original', { etag: '"v1"' })));
  await ofac.fetch(url);
  await writeFile(f.file, 'corrupt'); await ofac.fetch(url);
  await unlink(f.file); await ofac.fetch(url);
  await writeFile(f.metadata, 'broken json'); await ofac.fetch(url);
  await unlink(f.metadata); await ofac.fetch(url);
  await ofac.fetch('https://other.invalid/sdn.xml');
  assert.ok(f.calls.every(call => Object.keys(call.headers).length === 0));
});

test('cache removed during validation retries unconditionally', async t => {
  let f;
  f = await fixture(t, [response(200, 'old', { etag: '"v1"' }), async () => {
    await unlink(f.file); return response(304);
  }, response(200, 'restored', { etag: '"v2"' })]);
  await ofac.fetch(url); await ofac.fetch(url);
  assert.deepEqual(f.calls[2].headers, {});
  assert.equal(await readFile(f.file, 'utf8'), 'restored');
});

test('304 without a cache fails rather than reporting a successful refresh', async t => {
  await fixture(t, [response(304), response(304)]);
  await assert.rejects(ofac.fetch(url), /without a usable cache/);
});

test('HTTP and interrupted-download failures preserve the prior cache and validators', async t => {
  const interrupted = response(200, '', { etag: '"v2"' });
  interrupted.body = Readable.from((async function* () { yield 'partial'; throw new Error('transfer failed'); })());
  const f = await fixture(t, [response(200, 'original', { etag: '"v1"' }), response(503), interrupted]);
  await ofac.fetch(url);
  const metadata = await readFile(f.metadata, 'utf8');
  await assert.rejects(ofac.fetch(url), /503/);
  await assert.rejects(ofac.fetch(url), /transfer failed/);
  assert.equal(await readFile(f.file, 'utf8'), 'original');
  assert.equal(await readFile(f.metadata, 'utf8'), metadata);
  assert.deepEqual((await readdir(f.dir)).sort(), ['sdn.xml', 'sdn.xml.http.json']);
});
