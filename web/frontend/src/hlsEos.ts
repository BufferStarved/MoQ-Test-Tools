/** hls.js fatal playlist errors that mean the encode already ended. */

const PLAYLIST_GONE_DETAILS = new Set([
  "levelLoadError",
  "audioTrackLoadError",
  "manifestLoadError",
  "levelParsingError",
  "levelEmptyError",
]);

export function isGracefulHlsEos(options: {
  details: string;
  httpStatus?: number;
  playbackOk: boolean;
}): boolean {
  if (!options.playbackOk) {
    return false;
  }
  if (options.httpStatus === 404) {
    return true;
  }
  return PLAYLIST_GONE_DETAILS.has(options.details);
}
