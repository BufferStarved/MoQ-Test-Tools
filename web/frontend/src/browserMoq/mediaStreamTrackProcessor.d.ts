/** Chromium insertable-streams API — not in the default TypeScript DOM lib. */
interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}
