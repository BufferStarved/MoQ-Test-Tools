/**
 * Late HLS level/audio load errors after playback must be treated as EOS.
 * Mirrors web/frontend/src/hlsEos.ts.
 */
import assert from "node:assert/strict";

const PLAYLIST_GONE_DETAILS = new Set([
  "levelLoadError",
  "audioTrackLoadError",
  "manifestLoadError",
  "levelParsingError",
  "levelEmptyError",
]);

function isGracefulHlsEos(options) {
  if (!options.playbackOk) {
    return false;
  }
  if (options.httpStatus === 404) {
    return true;
  }
  return PLAYLIST_GONE_DETAILS.has(options.details);
}

assert.equal(
  isGracefulHlsEos({ details: "levelLoadError", playbackOk: true }),
  true,
);
assert.equal(
  isGracefulHlsEos({ details: "audioTrackLoadError", playbackOk: true }),
  true,
);
assert.equal(
  isGracefulHlsEos({ details: "levelParsingError", playbackOk: true }),
  true,
);
assert.equal(
  isGracefulHlsEos({ details: "bufferStalledError", httpStatus: 404, playbackOk: true }),
  true,
);
assert.equal(
  isGracefulHlsEos({ details: "levelLoadError", playbackOk: false }),
  false,
);
assert.equal(
  isGracefulHlsEos({ details: "bufferStalledError", playbackOk: true }),
  false,
);

console.log("unit-hls-eos: PASS");
