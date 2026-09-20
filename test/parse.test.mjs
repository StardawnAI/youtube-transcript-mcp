import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylistId, parseTranscript, parseVideoId } from '../src/youtube.mjs';

test('parseVideoId accepts the common link shapes', () => {
  const id = 'jNQXAC9IVRw';
  for (const input of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&list=PL123&index=2`,
    `https://youtu.be/${id}?t=42`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    id,
  ]) {
    assert.equal(parseVideoId(input), id, input);
  }
  assert.equal(parseVideoId('https://www.youtube.com/playlist?list=PL123'), null);
  assert.equal(parseVideoId('some search phrase'), null);
});

test('parsePlaylistId finds the list parameter', () => {
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=PLabc-123'), 'PLabc-123');
  assert.equal(parsePlaylistId('https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLabc'), 'PLabc');
  assert.equal(parsePlaylistId('https://youtu.be/jNQXAC9IVRw'), null);
});

test('parseTranscript reads word-level and paragraph-level captions', () => {
  const xml = `<timedtext format="3"><body>
    <p t="1200" d="2160"><s>All </s><s>right,</s></p>
    <p t="5000" d="1000">plain &amp;amp; simple &lt;b&gt;bold&lt;/b&gt;
line break</p>
    <p t="9000" d="500"> </p>
  </body></timedtext>`;
  const segments = parseTranscript(xml);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], {
    text: 'All right,', startMs: 1200, endMs: 3360, start: '00:00:01.200', end: '00:00:03.360',
  });
  // entities decoded once, escaped formatting dropped, caption line break becomes a space
  assert.equal(segments[1].text, 'plain &amp; simple bold line break');
});

test('parseTranscript survives a missing duration', () => {
  const [segment] = parseTranscript('<p t="500">hello</p>');
  assert.equal(segment.endMs, 500);
  assert.equal(segment.end, '00:00:00.500');
});
