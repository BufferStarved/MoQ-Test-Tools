/**
 * Harness-level catch-up vs completeness. Asked once at Encode, not per
 * output. WebRTC is always live — hide the control on WebRTC-only recipes
 * and on the WHEP tile of a mixed 4-way.
 */

export const PLAYBACK_POLICY_LIVE_EDGE = "live-edge";
export const PLAYBACK_POLICY_COMPLETE = "complete";

export type PlaybackPolicy = typeof PLAYBACK_POLICY_LIVE_EDGE | typeof PLAYBACK_POLICY_COMPLETE;

export const DEFAULT_PLAYBACK_POLICY: PlaybackPolicy = PLAYBACK_POLICY_LIVE_EDGE;

export const PLAYBACK_POLICY_LIVE_COPY = "Prefer live edge (may skip)";
export const PLAYBACK_POLICY_COMPLETE_COPY = "Prefer complete playback (may lag)";

export function parsePlaybackPolicy(value: unknown): PlaybackPolicy {
  return value === PLAYBACK_POLICY_COMPLETE ? PLAYBACK_POLICY_COMPLETE : PLAYBACK_POLICY_LIVE_EDGE;
}

export function isCompletePlayback(policy: PlaybackPolicy | string | null | undefined): boolean {
  return parsePlaybackPolicy(policy) === PLAYBACK_POLICY_COMPLETE;
}

/** Hide the Encode-step toggle when every output is WebRTC. */
export function playbackPolicyToggleVisible(protocols: Array<string | null | undefined>): boolean {
  const live = protocols.map((protocol) => (protocol || "").trim().toLowerCase()).filter(Boolean);
  if (live.length === 0) {
    return true;
  }
  return live.some((protocol) => protocol !== "webrtc");
}

/** Per-tile: WHEP is always live; do not show a policy badge there. */
export function playbackPolicyAppliesToEngine(engine: string | null | undefined): boolean {
  return (engine || "").trim().toLowerCase() !== "whep";
}

export function playbackPolicyBanner(policy: PlaybackPolicy | string | null | undefined): string {
  return isCompletePlayback(policy)
    ? "This run preferred complete playback (may lag)."
    : "This run preferred live edge (may skip).";
}

export function moqLocMaxCatchUpRate(
  policy: PlaybackPolicy | string | null | undefined,
  packaging: "cmaf" | "loc",
): number {
  if (packaging !== "loc") {
    return 1.0;
  }
  return isCompletePlayback(policy) ? 1.0 : 1.25;
}

export function moqCmafChasesLiveEdge(policy: PlaybackPolicy | string | null | undefined): boolean {
  return !isCompletePlayback(policy);
}

export function hlsCompleteLiveSyncSec(lowLatency: boolean): number {
  return lowLatency ? 3 : 0;
}

export function hlsMaxLiveSyncPlaybackRate(
  policy: PlaybackPolicy | string | null | undefined,
  options: { lowLatency: boolean; shallow?: boolean },
): number {
  if (isCompletePlayback(policy)) {
    return 1.0;
  }
  if (options.lowLatency) {
    return 1.15;
  }
  return options.shallow ? 1.0 : 1.1;
}

export function hlsAllowsLiveJump(policy: PlaybackPolicy | string | null | undefined): boolean {
  return !isCompletePlayback(policy);
}

export function mpegTsChasesLiveEdge(policy: PlaybackPolicy | string | null | undefined): boolean {
  return !isCompletePlayback(policy);
}

export function dashChasesLiveEdge(policy: PlaybackPolicy | string | null | undefined): boolean {
  return !isCompletePlayback(policy);
}
