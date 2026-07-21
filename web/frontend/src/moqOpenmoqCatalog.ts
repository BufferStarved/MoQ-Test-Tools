/**
 * Base64 fragmented-MP4 init segment (ftyp+moov) matching BROWSER_COMPAT_VIDEO_ARGS /
 * BROWSER_COMPAT_AUDIO_ARGS in src/moq_publish.py (H.264 Main profile level 4.0,
 * AAC-LC 128kbps/48kHz/stereo). Generated once via a local ffmpeg encode with the
 * exact same args and movflags used for the live publish pipeline, then extracted
 * as everything before the first `moof` box.
 *
 * Without this, `initData.byteLength` is 0, mse-adapter.ts's `initialize()` never
 * appends an init segment, and the player's first `moof+mdat` fragment append has
 * no preceding `moov`/track definitions — a fundamental MSE protocol violation.
 * Chrome reacts by silently invalidating the SourceBuffer, producing the exact same
 * symptom as the (separately fixed) AAC-corruption bug: every subsequent append
 * throws "This SourceBuffer has been removed from the parent media source" and zero
 * frames ever render, even though catalog + subscribe both succeed cleanly.
 *
 * mse-adapter.ts's `filterInitSegment(initData, 'vide' | 'soun')` extracts the
 * relevant single-track `trak` from this shared blob per track, so the same
 * base64 string is reused for both tracks below.
 */
const BENCHMARK_INIT_SEGMENT_B64 =
  "AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAABNptb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB/XRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFAAAAAtAAAAAAAZltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAADwAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAFEbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABBHN0YmwAAAC4c3RzZAAAAAAAAAABAAAAqGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFAALQAEgAAABIAAAAAAAAAAEVTGF2YzYyLjI4LjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAAuYXZjQwFNQCj/4QAXZ01AKNoBQBbsBEAAAAMAQAAADwPGDKgBAARo7zyAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAquYAAquYAAJiWgAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAG/dHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAABW21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAu4AAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAQZtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAMpzdGJsAAAAfnN0c2QAAAAAAAAAAQAAAG5tcDRhAAAAAAAAAAEAAAAAAAAAAAACABAAAAAAu4AAAAAAADZlc2RzAAAAAAOAgIAlAAIABICAgBdAFQAAAAAB9AAAAfQABYCAgAURkFblAAaAgIABAgAAABRidHJ0AAAAAAAB9AAAAfQAAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAABIbXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAIHRyZXgAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMg==";

/**
 * Synthetic MSF catalog matching openmoq-publisher defaults (vide_1 + soun_2, CMAF).
 * Used when moqx relay catalog retrieval is flaky — player subscribes to media directly.
 * @see tools/openmoq-publisher relay-interop.md
 */
export const OPENMOQ_BENCHMARK_CATALOG = {
  tracks: [
    {
      name: "vide_1",
      packaging: "cmaf" as const,
      isLive: true,
      role: "video" as const,
      // Must match BROWSER_COMPAT_VIDEO_ARGS in src/moq_publish.py (Main profile,
      // level 4.0 = 0x28). A mismatched level here vs. the actual encoded bitstream
      // can make the browser's SourceBuffer reject/reset appends mid-stream.
      codec: "avc1.4D4028",
      width: 1280,
      height: 720,
      bitrate: 2_500_000,
      framerate: 30,
      initData: BENCHMARK_INIT_SEGMENT_B64,
    },
    {
      name: "soun_2",
      packaging: "cmaf" as const,
      isLive: true,
      role: "audio" as const,
      codec: "mp4a.40.2",
      samplerate: 48_000,
      channelConfig: "2",
      bitrate: 128_000,
      initData: BENCHMARK_INIT_SEGMENT_B64,
    },
  ],
};

/**
 * Catalog for the actual media the source produces. Advertising soun_2 when
 * the capture has no audio track (no/denied/broken microphone — or the QA
 * harness's simulated no-mic environment) makes the player subscribe to a
 * track the publisher never registers; the relay refuses it ("no such
 * namespace or track") and @playa/player escalates to a fatal
 * all-tracks-refused teardown that kills the perfectly good video
 * subscription with it. Video-only sources must advertise video only.
 */
export function openmoqBenchmarkCatalog(includeAudio: boolean) {
  if (includeAudio) {
    return OPENMOQ_BENCHMARK_CATALOG;
  }
  return {
    tracks: OPENMOQ_BENCHMARK_CATALOG.tracks.filter((track) => track.role !== "audio"),
  };
}
