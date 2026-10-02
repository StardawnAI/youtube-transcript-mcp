import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTranscripts, saveTranscripts, toolFor } from '../src/mcp-server.mjs';
import { BlockedError, getTranscripts } from '../src/youtube.mjs';

const ids = (n) => Array.from({ length: n }, (_, i) => `video${String(i).padStart(6, '0')}`);
const ok = (videoId) => ({ videoId, title: `Title ${videoId}`, fullText: `text of ${videoId}`, totalSegments: 3, language: 'en' });

test('results keep the order of the ids, however the workers interleave', async () => {
  const fetcher = async (videoId) => {
    await new Promise((r) => setTimeout(r, videoId.endsWith('0') ? 30 : 1));
    return ok(videoId);
  };
  const result = await getTranscripts(ids(12), { concurrency: 4, fetcher });
  assert.deepEqual(result.videos.map((v) => v.videoId), ids(12));
  assert.equal(result.successful, 12);
});

test('a failed video is reported and the run goes on', async () => {
  const fetcher = async (videoId) => {
    if (videoId === ids(5)[2]) throw new Error('No captions available');
    return ok(videoId);
  };
  const result = await getTranscripts(ids(5), { fetcher });
  assert.equal(result.successful, 4);
  assert.equal(result.skipped, 1);
  assert.match(result.videos[2].reason, /No captions/);
});

test('a block in the middle of a run switches the route and continues with the videos that are left', async () => {
  const seen = [];
  const fetcher = async (videoId, { proxy }) => {
    seen.push([videoId, proxy]);
    if (!proxy && videoId >= ids(6)[3]) throw new BlockedError('Sign in to confirm you are not a bot');
    return ok(videoId);
  };
  let offers = 0;
  const result = await getTranscripts(ids(6), { fetcher, onBlocked: async () => (offers++ ? null : 'http://warp:1080') });
  assert.equal(result.successful, 6);
  assert.equal(offers, 1);
  // The first three ran direct, the rest through the new route; nothing ran twice with the same outcome
  assert.deepEqual(seen.filter(([, p]) => !p).map(([v]) => v), [0, 1, 2, 3].map((i) => ids(6)[i]));
  assert.equal(seen.filter(([, p]) => p).length, 3);
});

test('parallel workers that are blocked together ask for the new route once', async () => {
  let offers = 0;
  const fetcher = async (videoId, { proxy }) => {
    if (!proxy) throw new BlockedError('blocked');
    return ok(videoId);
  };
  const result = await getTranscripts(ids(6), {
    concurrency: 3,
    fetcher,
    onBlocked: async () => { offers++; await new Promise((r) => setTimeout(r, 20)); return 'http://warp:1080'; },
  });
  assert.equal(result.successful, 6);
  assert.equal(offers, 1);
});

test('a block that stays stops the run after three videos in a row and keeps what it has', async () => {
  const fetched = [];
  const fetcher = async (videoId) => {
    fetched.push(videoId);
    if (fetched.length > 2) throw new BlockedError('blocked');
    return ok(videoId);
  };
  const result = await getTranscripts(ids(20), { fetcher });
  assert.equal(result.successful, 2);
  assert.match(result.stoppedEarly, /kept refusing/);
  assert.equal(fetched.length, 5); // two good, three blocked, then it stops
  assert.equal(result.videos.length, 20);
  assert.match(result.videos[19].reason, /not attempted/);
});

test('blocked from the very first video throws, so the caller can pick another route', async () => {
  await assert.rejects(
    getTranscripts(ids(10), { fetcher: async () => { throw new BlockedError('blocked'); } }),
    BlockedError,
  );
});

test('saveTranscripts writes one file per video and answers with an index, not the text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yt-bulk-'));
  try {
    const fetcher = async (videoId) => {
      if (videoId === ids(3)[1]) throw new Error('No captions available');
      return ok(videoId);
    };
    const result = await saveTranscripts(ids(3), { dir: join(dir, 'out'), route: { proxy: null }, fetcher });

    assert.equal(result.savedTo, join(dir, 'out'));
    assert.equal(result.successful, 2);
    assert.deepEqual((await readdir(join(dir, 'out'))).sort(), [`${ids(3)[0]}.txt`, `${ids(3)[2]}.txt`]);
    assert.equal(await readFile(join(dir, 'out', `${ids(3)[0]}.txt`), 'utf8'), `text of ${ids(3)[0]}\n`);

    const [first, skipped] = result.videos;
    assert.equal(first.videoId, ids(3)[0]);
    assert.equal(first.characters, `text of ${ids(3)[0]}`.length);
    assert.equal(first.fullText, undefined);
    assert.equal(skipped.skipped, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Inline mode: the answer carries the text, in portions, for a server that
// cannot leave files behind.
// ---------------------------------------------------------------------------
test('inline: stops at the budget and says where to continue', async () => {
  const fetcher = async (videoId) => ok(videoId);
  const result = await collectTranscripts(ids(12), { route: { proxy: null }, fetcher, budget: 40, offset: 10 });
  assert.equal(result.videos.length, 3); // one batch of three is already past 40 characters
  assert.equal(result.nextOffset, 13);
  assert.equal(result.remainingInThisRequest, 9);
  assert.ok(result.videos.every((v) => typeof v.fullText === 'string' && v.segments === undefined && v.channelId === undefined));
});

test('inline: a request that fits in the budget has no nextOffset', async () => {
  const result = await collectTranscripts(ids(5), { route: { proxy: null }, fetcher: async (id) => ok(id), budget: 100000 });
  assert.equal(result.successful, 5);
  assert.equal(result.nextOffset, undefined);
});

test('inline: a block after the first portion returns what was read, a block at the start throws', async () => {
  const late = async (videoId) => {
    if (videoId >= ids(12)[3]) throw new BlockedError('blocked');
    return ok(videoId);
  };
  const result = await collectTranscripts(ids(12), { route: { proxy: null }, fetcher: late, budget: 100000 });
  assert.equal(result.successful, 3);
  assert.match(result.stoppedEarly, /kept refusing/);
  assert.equal(result.nextOffset, undefined); // nothing sensible to continue with while blocked

  await assert.rejects(
    collectTranscripts(ids(6), { route: { proxy: null }, fetcher: async () => { throw new BlockedError('blocked'); }, budget: 100000 }),
    BlockedError,
  );
});

test('the tool description follows the output mode: no save_to for a server that answers inline', () => {
  const files = toolFor('files');
  const inline = toolFor('inline');
  assert.ok(files.inputSchema.properties.save_to);
  assert.equal(inline.inputSchema.properties.save_to, undefined);
  assert.ok(inline.inputSchema.properties.offset && files.inputSchema.properties.offset);
  assert.match(inline.description, /nextOffset/);
  assert.match(files.description, /written to files/);
});

test('a new WARP identity behind the same proxy address is a route change too', async () => {
  // The address of the proxy stays the same; only its exit address changes. Parallel
  // workers that are blocked together must ask once per change, and every one of them
  // must retry after it, however the timing falls.
  let identity = 0;
  let offers = 0;
  const fetcher = async (videoId) => {
    if (identity < 2) throw new BlockedError('blocked');
    return ok(videoId);
  };
  const result = await getTranscripts(ids(9), {
    proxy: 'http://warp:1080',
    concurrency: 3,
    fetcher,
    onBlocked: async () => {
      offers++;
      await new Promise((r) => setTimeout(r, 15));
      identity++;
      return 'http://warp:1080';
    },
  });
  assert.equal(result.successful, 9);
  assert.equal(offers, 2);
});
