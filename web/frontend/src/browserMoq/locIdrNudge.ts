/** Player → publisher IDR request without tearing the MoQ session. */

let nudge: (() => void) | undefined;

export function setLocIdrNudge(fn: (() => void) | undefined): void {
  nudge = fn;
}

export function requestLocIdr(): void {
  nudge?.();
}
