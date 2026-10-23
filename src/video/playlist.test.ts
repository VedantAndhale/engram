import { test } from "node:test";
import assert from "node:assert/strict";
import { playlistIdOf, playlistName, playlistVideoIds } from "./playlist";

test("a playlist page link gives its list id; a watch link with a list is a video, not a playlist", () => {
  assert.equal(playlistIdOf("https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs"), "PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs");
  assert.equal(playlistIdOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs"), null);
  assert.equal(playlistIdOf("https://example.com/playlist?list=PL123"), null);
  assert.equal(playlistIdOf("https://www.youtube.com/playlist"), null);
});

test("the videos of one playlist come in the order its page numbers them, once each", () => {
  const html = [
    '{"watchEndpoint":{"videoId":"bbbbbbbbbbb","playlistId":"PLx","index":1}}',
    '{"watchEndpoint":{"videoId":"aaaaaaaaaaa","playlistId":"PLx","index":0}}',
    '{"watchEndpoint":{"videoId":"aaaaaaaaaaa","playlistId":"PLx","index":0}}',
    '{"watchEndpoint":{"videoId":"ccccccccccc","playlistId":"PLother","index":0}}',
  ].join("");
  assert.deepEqual(playlistVideoIds(html, "PLx"), ["aaaaaaaaaaa", "bbbbbbbbbbb"]);
});

test("the name is the page's title with escapes undone", () => {
  assert.equal(playlistName('<meta property="og:title" content="Rock &amp; Roll &quot;Best&quot;">'), 'Rock & Roll "Best"');
  assert.equal(playlistName("<html></html>"), undefined);
});
