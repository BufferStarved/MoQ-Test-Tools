/**
 * OpenMOQ default track names (vide_1 + soun_2, CMAF).
 *
 * Do **not** inject a canned catalog `initData` into the player.
 * `NextGroupStart` joins mid-stream, so MSE never sees this encode's
 * `ftyp+moov`. A baked 720p Main-4.0 blob (especially one made on a
 * different ffmpeg / ladder / burn-in) initializes SourceBuffers that
 * then reject every live fragment — catalog "ready", zero frames.
 * Subscribe to the publisher `catalog` track instead; `--publish-catalog`
 * ships the matching init for this encode.
 *
 * @see tools/openmoq-publisher relay-interop.md
 */
export const OPENMOQ_VIDEO_TRACK = "vide_1";
export const OPENMOQ_AUDIO_TRACK = "soun_2";
export const OPENMOQ_VIDEO_CODEC = "avc1.4D4028";
export const OPENMOQ_AUDIO_CODEC = "mp4a.40.2";

/**
 * Names-only track list for tests / diagnostics. Deliberately has no
 * `initData` — injecting one is what produced silent black CMAF players.
 */
export function openmoqBenchmarkCatalog(includeAudio: boolean) {
  const tracks: Array<{
    name: string;
    packaging: "cmaf";
    isLive: true;
    role: "video" | "audio";
    codec: string;
    width?: number;
    height?: number;
    bitrate: number;
    framerate?: number;
    samplerate?: number;
    channelConfig?: string;
  }> = [
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
