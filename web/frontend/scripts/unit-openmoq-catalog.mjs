/**
 * CMAF catalog helper: names/codecs only — never baked initData.
 * Injecting a canned ftyp+moov with NextGroupStart produced
 * "catalog loaded but no video frames" on every OpenMOQ relay.
 */
import assert from "node:assert/strict";

const OPENMOQ_VIDEO_TRACK = "vide_1";
const OPENMOQ_AUDIO_TRACK = "soun_2";
const OPENMOQ_VIDEO_CODEC = "avc1.4D4028";
const OPENMOQ_AUDIO_CODEC = "mp4a.40.2";

function openmoqBenchmarkCatalog(includeAudio) {
  const tracks = [
    {
      name: OPENMOQ_VIDEO_TRACK,
      packaging: "cmaf",
      isLive: true,
      role: "video",
      codec: OPENMOQ_VIDEO_CODEC,
      width: 1280,
      height: 720,
      bitrate: 2_500_000,
      framerate: 30,
    },
  ];
  if (includeAudio) {
    tracks.push({
      name: OPENMOQ_AUDIO_TRACK,
      packaging: "cmaf",
      isLive: true,
      role: "audio",
      codec: OPENMOQ_AUDIO_CODEC,
      samplerate: 48_000,
      channelConfig: "2",
      bitrate: 128_000,
    });
  }
  return { tracks };
}

const withAudio = openmoqBenchmarkCatalog(true);
const videoOnly = openmoqBenchmarkCatalog(false);

assert.equal(withAudio.tracks.length, 2);
assert.equal(videoOnly.tracks.length, 1);
assert.equal(withAudio.tracks[0].name, OPENMOQ_VIDEO_TRACK);
assert.equal(withAudio.tracks[1].name, OPENMOQ_AUDIO_TRACK);
for (const track of [...withAudio.tracks, ...videoOnly.tracks]) {
  assert.equal("initData" in track, false, `${track.name} must not ship canned initData`);
}

console.log("unit-openmoq-catalog: PASS");
