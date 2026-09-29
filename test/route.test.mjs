import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRoute } from '../src/mcp-server.mjs';
import { BlockedError } from '../src/youtube.mjs';

const WARP = 'http://127.0.0.1:1080';
const base = { configuredProxy: () => null, readConfig: async () => ({}), dockerAvailable: () => true };
const silent = () => {};
const warpUp = () => ({ starts: 0, async startWarp() { this.starts++; return { proxy: WARP, ip: '104.28.0.1' }; } });

test('a single video goes out directly, and a block starts WARP and runs it again', async () => {
  const seen = [];
  const run = async (route) => {
    seen.push(route.proxy);
    if (!route.proxy) throw new BlockedError('Sign in to confirm you are not a bot');
    return 'transcript';
  };
  const warp = warpUp();
  const result = await withRoute(run, { notify: silent }, { ...base, startWarp: () => warp.startWarp() });
  assert.equal(result, 'transcript');
  assert.deepEqual(seen, [null, WARP]);
  assert.equal(warp.starts, 1);
});

test('a run of many videos starts on WARP, with no direct attempt first', async () => {
  const seen = [];
  const warp = warpUp();
  await withRoute(async (route) => { seen.push(route.proxy); return 'done'; }, { bulk: true, notify: silent }, { ...base, startWarp: () => warp.startWarp() });
  assert.deepEqual(seen, [WARP]);
  assert.equal(warp.starts, 1);
});

test('WARP is offered as a better route once per run, and only once', async () => {
  const warp = warpUp();
  const offers = [];
  await withRoute(async (route, onBlocked) => {
    offers.push(await onBlocked(), await onBlocked());
    return 'done';
  }, { notify: silent }, { ...base, startWarp: () => warp.startWarp() });
  assert.deepEqual(offers, [WARP, null]);
  assert.equal(warp.starts, 1);
});

test('without Docker a run of many videos goes out directly and says why in the block message', async () => {
  const seen = [];
  const messages = [];
  await assert.rejects(
    withRoute(async (route) => { seen.push(route.proxy); throw new BlockedError('blocked'); }, { bulk: true, notify: (m) => messages.push(m) }, {
      ...base,
      dockerAvailable: () => false,
      startWarp: async () => assert.fail('must not start WARP without Docker'),
    }),
    (e) => e instanceof BlockedError && /Docker is not running here/.test(e.message) && /YOUTUBE_TRANSCRIPT_PROXY/.test(e.message),
  );
  assert.deepEqual(seen, [null]);
  assert.ok(messages.some((m) => /Docker is not running here/.test(m)));
});

test('WARP that fails to start is reported with its own reason', async () => {
  await assert.rejects(
    withRoute(async () => { throw new BlockedError('blocked'); }, { notify: silent }, {
      ...base,
      startWarp: async () => { throw new Error('WARP did not connect'); },
    }),
    /WARP did not connect/,
  );
});

test('a proxy the user configured is used as given and never replaced', async () => {
  for (const bulk of [false, true]) {
    const seen = [];
    await assert.rejects(
      withRoute(async (route) => { seen.push(route.proxy); throw new BlockedError('blocked'); }, { bulk, notify: silent }, {
        ...base,
        configuredProxy: () => 'http://already-configured:3128',
        startWarp: async () => assert.fail('must not start WARP when a proxy is configured'),
      }),
      /blocked/,
    );
    assert.deepEqual(seen, ['http://already-configured:3128']);
  }
});

test('other errors pass through untouched', async () => {
  await assert.rejects(
    withRoute(async () => { throw new Error('no captions'); }, { notify: silent }, {
      ...base,
      startWarp: async () => assert.fail('must not start WARP for a plain error'),
    }),
    /no captions/,
  );
});

test('autoWarp: false in the config switches WARP off, also for many videos', async () => {
  for (const bulk of [false, true]) {
    await assert.rejects(
      withRoute(async () => { throw new BlockedError('blocked'); }, { bulk, notify: silent }, {
        ...base,
        readConfig: async () => ({ autoWarp: false }),
        startWarp: async () => assert.fail('must not start WARP when switched off'),
      }),
      /blocked/,
    );
  }
});
