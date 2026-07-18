export type PlaybackMode =
  | "auto"
  | "hls"
  | "ll-hls"
  | "dash"
  | "ll-dash"
  | "webrtc"
  | "whep"
  | "moq"
  | "mpegts"
  | "zixi-embed";

export type PlaybackEngine =
  | "hls"
  | "dash"
  | "webrtc-embed"
  | "whep"
  | "moq"
  | "mpegts"
  | "flv"
  | "unsupported";

export interface PlaybackTarget {
  engine: PlaybackEngine;
  url: string;
  label: string;
  note?: string;
  embedUrl?: string;
  streamId?: string;
  host?: string;
  moqNamespace?: string;
  moqFingerprintUrl?: string;
}
