import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, parseSocialLink, runSocialTool, shape } from '../src/social.mjs';
import { tools } from '../src/mcp-server.mjs';

const TT = 'https://www.tiktok.com/@tagesschau/video/7702581353048624387';

function result(id, text, extra = {}) {
  return {
    schema_version: '1.0', job_id: id, kind: 'video', status: 'completed', platform_requests: 2, warnings: [],
    media: { platform: 'tiktok', platform_id: id.replace('job_', ''), canonical_url: `https://www.tiktok.com/@a/video/${id}`, title: 'T', author: 'a', duration_seconds: 34 },
    artifacts: [{ artifact_id: 'art_1', kind: 'video', mime_type: 'video/mp4', size: 3, sha256: 'abc' }],
    transcript: { status: text ? 'available' : 'no_speech', source: 'asr', language: text ? 'de' : null, model: 'large-v3-turbo', text, segments: text ? [{ start_ms: 1200, end_ms: 3360, text }] : [] },
    ...extra,
  };
}

// A worker stand-in: answers 202 `pending` times per job, then the result.
function fakeApi({ results = {}, pending = 1, profile } = {}) {
  const seen = {};
  const calls = [];
  return {
    calls,
    submit: async (body) => { calls.push(['submit', body]); return { job_id: 'job_v', status: 'queued', existing: false }; },
    submitProfile: async (body) => { calls.push(['profile', body]); return { job_id: 'job_p', status: 'queued', existing: false }; },
    result: async (id) => {
      seen[id] = (seen[id] || 0) + 1;
      if (id === 'job_p') return profile(seen[id]);
      if (seen[id] <= pending) return { status: 202, data: { status: 'fetching', retry_after_s: 1 } };
      return { status: 200, data: results[id] };
    },
    download: async (art, file) => { calls.push(['download', art, file]); return file; },
  };
}

const deps = (api, extra = {}) => ({ worker: { url: 'x', key: 'k' }, api, pollMs: 0, ...extra });

test('links: videos, short links and accounts on both platforms, nothing else', () => {
  const cases = {
    [TT]: 'tiktok/video',
    'https://vm.tiktok.com/ZMabc/': 'tiktok/video',
    'tiktok.com/@tagesschau': 'tiktok/profile',
    'https://www.instagram.com/reel/DNoIGNAu8fy/': 'instagram/video',
    'https://www.instagram.com/p/XYZ/?igsh=1': 'instagram/video',
    'https://www.instagram.com/tagesschau/': 'instagram/profile',
    'https://www.instagram.com/explore/': null,
    'https://www.youtube.com/watch?v=x': null,
    'https://tiktok.com.evil.io/@a': null,
  };
  for (const [url, want] of Object.entries(cases)) {
    const got = parseSocialLink(url);
    assert.equal(got ? `${got.platform}/${got.kind}` : null, want, url);
  }
});

test('a video waits for the worker and answers like the YouTube tool', async () => {
  const api = fakeApi({ results: { job_v: result('job_v', 'Hallo zusammen') } });
  const out = await runSocialTool({ url: TT, language: 'de' }, {}, deps(api));
  assert.equal(out.fullText, 'Hallo zusammen');
  assert.deepEqual(out.segments, [{ text: 'Hallo zusammen', start: '00:00:01.200', end: '00:00:03.360', startMs: 1200, endMs: 3360 }]);
  assert.equal(out.source, 'asr');
  assert.equal(out.video.artifactId, 'art_1');
  assert.deepEqual(api.calls[0], ['submit', { url: TT, route: 'direct', language: 'de' }]);
});

test('music comes back empty with a note, not as an error', () => {
  const out = shape(result('job_m', ''));
  assert.equal(out.transcriptStatus, 'no_speech');
  assert.equal(out.fullText, '');
  assert.match(out.note, /No speech/);
});

test('a video that takes longer than the wait says so and can be asked again', async () => {
  const api = fakeApi({ pending: 1000 });
  const out = await runSocialTool({ url: TT }, {}, deps(api, { seconds: 0.05 }));
  assert.equal(out.status, 'running');
  assert.equal(out.jobId, 'job_v');
});

test('a failed video is a tool error with its class', async () => {
  const api = fakeApi({ results: { job_v: { ...result('job_v', ''), status: 'failed', error: { class: 'private', message: 'This post is private' } } } });
  await assert.rejects(runSocialTool({ url: TT }, {}, deps(api)), /private — This post is private/);
});

test('warp is started before a job that asks for it', async () => {
  let started = 0;
  const api = fakeApi({ results: { job_v: result('job_v', 'x') } });
  await runSocialTool({ url: TT, route: 'warp' }, {}, deps(api, { ensureWarp: async () => { started++; } }));
  assert.equal(started, 1);
  assert.equal(api.calls[0][1].route, 'warp');
});

test('a profile writes one file per video and answers with an index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smt-'));
  try {
    const videos = [{ id: '1', url: 'u1', job_id: 'job_1' }, { id: '2', url: 'u2', job_id: 'job_2' }, { id: '3', url: 'u3', job_id: 'job_3' }];
    const api = fakeApi({
      pending: 0,
      results: {
        job_1: result('job_1', 'erster'),
        job_2: { ...result('job_2', ''), status: 'failed', error: { class: 'unavailable', message: 'gone' } },
        job_3: result('job_3', 'dritter'),
      },
      profile: (n) => (n === 1 ? { status: 202, data: { status: 'resolving' } } : { status: 200, data: { status: 'completed', videos, warnings: [] } }),
    });
    const out = await runSocialTool({ url: 'https://www.tiktok.com/@a', max_videos: 3, save_to: dir }, {}, deps(api));
    assert.equal(out.totalVideos, 3);
    assert.equal(out.successful, 2);
    assert.equal(out.skipped, 1);
    assert.deepEqual((await readdir(dir)).sort(), ['tiktok_1.txt', 'tiktok_3.txt']);
    assert.equal((await readFile(join(dir, 'tiktok_1.txt'), 'utf8')).trim(), 'erster');
    assert.equal(out.videos[0].characters, 6);
    assert.equal(out.videos[0].fullText, undefined);
    assert.deepEqual(api.calls[0], ['profile', { url: 'https://www.tiktok.com/@a', max_items: 3, route: 'direct' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('inline, a profile pages its text with nextOffset', async () => {
  const big = 'x'.repeat(60000);
  const videos = [1, 2, 3].map((i) => ({ id: String(i), url: `u${i}`, job_id: `job_${i}` }));
  const api = fakeApi({
    pending: 0,
    results: { job_1: result('job_1', big), job_2: result('job_2', big), job_3: result('job_3', 'kurz') },
    profile: () => ({ status: 200, data: { status: 'completed', videos, warnings: [] } }),
  });
  const first = await runSocialTool({ url: 'https://www.tiktok.com/@a' }, {}, deps(api, { output: 'inline' }));
  assert.equal(first.nextOffset, 2);
  assert.equal(first.videos.filter((v) => v.fullText).length, 2);
  const second = await runSocialTool({ url: 'https://www.tiktok.com/@a', offset: 2 }, {}, deps(api, { output: 'inline' }));
  assert.equal(second.nextOffset, undefined);
  assert.equal(second.videos[0].fullText, 'kurz');
});

test('a YouTube link is sent to the other tool', async () => {
  await assert.rejects(runSocialTool({ url: 'https://youtu.be/jNQXAC9IVRw' }, {}, deps(fakeApi())), /get_youtube_transcript/);
});

test('a server elsewhere offers the social tool only with a worker to use', () => {
  const saved = process.env.YOUTUBE_TRANSCRIPT_OUTPUT;
  try {
    process.env.YOUTUBE_TRANSCRIPT_OUTPUT = 'inline';
    assert.deepEqual(tools({}).map((t) => t.tool.name), ['get_youtube_transcript']);
    assert.deepEqual(tools({ SMTRANSCRIPT_WORKER_URL: 'http://w' }).map((t) => t.tool.name), ['get_youtube_transcript', 'get_social_transcript']);
    delete process.env.YOUTUBE_TRANSCRIPT_OUTPUT;
    assert.equal(tools({}).length, 2);
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_TRANSCRIPT_OUTPUT;
    else process.env.YOUTUBE_TRANSCRIPT_OUTPUT = saved;
  }
});

test('the HTTP client sends the key and keeps 202 apart from 200', async () => {
  const auth = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    if (req.url === '/v1/jobs/job_a/result') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'fetching' }));
    }
    if (req.url === '/v1/artifacts/art_1') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return res.end('mp4');
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_input', message: 'not a TikTok or Instagram link' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'smt-'));
  try {
    const api = client({ url: `http://127.0.0.1:${server.address().port}`, key: 'secret' });
    assert.deepEqual(await api.result('job_a'), { status: 202, data: { status: 'fetching' } });
    await assert.rejects(api.submit({ url: 'x' }), /not a TikTok or Instagram link/);
    const file = await api.download('art_1', join(dir, 'v.mp4'));
    assert.equal(await readFile(file, 'utf8'), 'mp4');
    assert.ok(auth.every((a) => a === 'Bearer secret'));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
