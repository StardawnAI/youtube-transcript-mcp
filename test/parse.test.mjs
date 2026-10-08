import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylistId, parseTranscript, parseVideoId, pickTrack } from '../src/youtube.mjs';

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

// Caption lists as YouTube returns them (hl=en): sorted by language name, so a
// translation such as Arabic comes first.
const track = (languageCode, kind) => ({ languageCode, ...(kind ? { kind } : {}) });

test('pickTrack takes the video\'s own language when YouTube dubs it automatically', () => {
  const tracks = ['ar', 'bn', 'nl-NL', 'en', 'fr-FR', 'de-DE'].map((l) => track(l, 'asr'));
  const captions = { captionTracks: tracks, defaultTranslationSourceTrackIndices: [3] };
  assert.equal(pickTrack(captions).languageCode, 'en');
});

test('pickTrack takes the video\'s own language over subtitle translations', () => {
  const tracks = [track('ar'), track('zh-Hans'), track('en'), track('en', 'asr'), track('fr')];
  assert.equal(pickTrack({ captionTracks: tracks, defaultTranslationSourceTrackIndices: [2] }), tracks[2]);
  // the default caption track of the original audio track says the same
  const audioTracks = [{ audioTrackId: 'fr.3', defaultCaptionTrackIndex: 2 }, { audioTrackId: 'en-US.4', defaultCaptionTrackIndex: 2 }];
  assert.equal(pickTrack({ captionTracks: tracks, audioTracks, defaultAudioTrackIndex: 1 }), tracks[2]);
});

test('pickTrack falls back to written captions, and a requested language wins', () => {
  const tracks = [track('de', 'asr'), track('en'), track('es')];
  assert.equal(pickTrack({ captionTracks: tracks }), tracks[1]);
  assert.equal(pickTrack({ captionTracks: tracks, defaultTranslationSourceTrackIndices: [1] }, 'es'), tracks[2]);
  assert.equal(pickTrack({ captionTracks: [track('pt-BR')] }, 'pt').languageCode, 'pt-BR');
  assert.equal(pickTrack({ captionTracks: [] }), null);
});
