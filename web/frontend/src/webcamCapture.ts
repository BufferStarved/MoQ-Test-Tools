/** Safety cap: the local publisher agent's webcam job auto-stops if the user
 * never presses Stop. */
export const LIVE_WEBCAM_MAX_DURATION_SEC = 300;

export function webcamCaptureSeconds(): number {
  return LIVE_WEBCAM_MAX_DURATION_SEC;
}
