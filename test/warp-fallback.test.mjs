import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWarpFallback } from '../src/mcp-server.mjs';
import { BlockedError } from '../src/youtube.mjs';

const noDeps = { resolveProxy: async () => null, readConfig: async () => ({}), dockerAvailable: () => true };
const silent = () => {};

test('a blocked request starts WARP and runs again through the proxy', async () => {
  const seen = [];
  const run = async (proxy) => {
    seen.push(proxy);
    if (!proxy) throw new BlockedError('Sign in to confirm you are not a bot');
    return 'transcript';
  };
  const result = await withWarpFallback(run, silent, {
    ...noDeps,
    startWarp: async () => ({ proxy: 'http://127.0.0.1:1080', ip: '104.28.0.1' }),
  });
  assert.equal(result, 'transcript');
  assert.deepEqual(seen, [null, 'http://127.0.0.1:1080']);
});

test('without Docker the user gets told what to do instead', async () => {
  await assert.rejects(
    withWarpFallback(async () => { throw new BlockedError('blocked'); }, silent, {
      ...noDeps,
      dockerAvailable: () => false,
      startWarp: async () => assert.fail('must not start WARP without Docker'),
    }),
    (e) => e instanceof BlockedError && /Docker is not running here|YOUTUBE_TRANSCRIPT_PROXY/.test(e.message),
  );
});

test('other errors pass through untouched, and a proxy is never replaced', async () => {
  await assert.rejects(
    withWarpFallback(async () => { throw new Error('no captions'); }, silent, {
      ...noDeps,
      startWarp: async () => assert.fail('must not start WARP for a plain error'),
    }),
    /no captions/,
  );

  await assert.rejects(
    withWarpFallback(async () => { throw new BlockedError('blocked'); }, silent, {
      ...noDeps,
      resolveProxy: async () => 'http://already-configured:1080',
      startWarp: async () => assert.fail('must not start WARP when a proxy is configured'),
    }),
    /blocked/,
  );
});

test('autoWarp: false in the config disables the fallback', async () => {
  await assert.rejects(
    withWarpFallback(async () => { throw new BlockedError('blocked'); }, silent, {
      ...noDeps,
      readConfig: async () => ({ autoWarp: false }),
      startWarp: async () => assert.fail('must not start WARP when switched off'),
    }),
    /blocked/,
  );
});
