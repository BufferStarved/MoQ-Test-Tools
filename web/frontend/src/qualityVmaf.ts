/** Which quality scores a benchmark leg will actually compute. */

export function wantsEncoderVmaf(options: {
  computeVmaf: boolean;
  encoderVmafAvailable: boolean;
  protocol: string;
  isLive: boolean;
}): boolean {
  return (
    options.computeVmaf &&
    options.encoderVmafAvailable &&
    !options.isLive &&
    (options.protocol || "").toLowerCase() !== "webrtc"
  );
}

export function wantsIngestVmaf(options: {
  computeVmaf: boolean;
  vmafAvailable: boolean;
  isLive: boolean;
  isBrowserSource: boolean;
}): boolean {
  return (
    options.computeVmaf &&
    options.vmafAvailable &&
    (!options.isLive || options.isBrowserSource)
  );
}

export function encoderVmafSkipReason(protocol: string, isLive: boolean): string | null {
  if ((protocol || "").toLowerCase() === "webrtc") {
    return "WHIP cannot tee an encoder capture";
  }
  if (isLive) {
    return "Live camera has no file reference for encoder VMAF";
  }
  return null;
}

export function ingestVmafSkipReason(options: {
  vmafAvailable: boolean;
  isLive: boolean;
  isBrowserSource: boolean;
}): string | null {
  if (options.isLive && !options.isBrowserSource) {
    return "Webcam ingest VMAF needs a file reference on the ingest host";
  }
  if (!options.vmafAvailable) {
    return "Ingest VMAF needs a Zixi TS recorder or a MoQ post-relay recorder (not WebRTC/WHIP)";
  }
  return null;
}

/** True when a quality leg is real libvmaf — not a QP stand-in. */
export function qualityAnalysisWasRequested(options: {
  computeVmafOnIngest?: boolean;
  computeVmafEncoder?: boolean;
}): boolean {
  return Boolean(options.computeVmafOnIngest || options.computeVmafEncoder);
}

export function isRealVmafLeg(leg?: {
  vmaf_score?: number | null;
  computed_on?: string;
  status?: string;
} | null): boolean {
  if (!leg || leg.vmaf_score == null || !Number.isFinite(leg.vmaf_score)) {
    return false;
  }
  const on = (leg.computed_on || "").toLowerCase();
  return on !== "webrtc_qp" && on !== "disabled";
}

export function qualityStatusTerminal(status?: string | null): boolean {
  return (
    !status ||
    status === "completed" ||
    status === "failed" ||
    status === "disabled"
  );
}
