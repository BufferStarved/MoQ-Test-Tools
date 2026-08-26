import type { EncoderId, MediaSourceId } from "./SourceSection";
import type { PlaybackMode } from "./playbackTypes";
import type { EndpointConfig } from "./types";

/**
 * Operator deep-links for laptop-only cases (camera + real Chrome WebTransport).
 *
 *   /?operator=browser4
 *   /?source=browser&outputs=linode_moq,linode_webrtc,east_moq,east_webrtc
 *   /?source=webcam
 *   /?source=webcam&encoder=ffmpeg
 *   /?source=webcam&encoder=obs
 *   /?source=webcam&encoder=browser
 *   /?operator=playa                 (webcam + west draft-18 canary)
 *   /?operator=playa-file            (cloud BBB + west draft-18 canary)
 *   /?source=webcam&outputs=gcp_d18
 *   /?harnessJob=JOB&playback=moq   (HarnessPage — single job)
 */
export type OperatorOutputSpec = {
  protocol: "moq" | "webrtc";
  ingestEndpointId: string;
  playbackMode: PlaybackMode;
};

export const OPERATOR_OUTPUTS: Record<string, OperatorOutputSpec> = {
  linode_moq: {
    protocol: "moq",
    ingestEndpointId: "linode_moq_relay_d18",
    playbackMode: "moq",
  },
  linode_webrtc: {
    protocol: "webrtc",
    ingestEndpointId: "linode_mediamtx",
    playbackMode: "whep",
  },
  east_moq: {
    protocol: "moq",
    ingestEndpointId: "gcp_east_moq_relay_d18",
    playbackMode: "moq",
  },
  east_webrtc: {
    protocol: "webrtc",
    ingestEndpointId: "gcp_east_mediamtx",
    playbackMode: "whep",
  },
  gcp_east_moq: {
    protocol: "moq",
    ingestEndpointId: "gcp_east_moq_relay_d18",
    playbackMode: "moq",
  },
  gcp_east_webrtc: {
    protocol: "webrtc",
    ingestEndpointId: "gcp_east_mediamtx",
    playbackMode: "whep",
  },
  gcp_d18: {
    protocol: "moq",
    ingestEndpointId: "gcp_moq_relay_d18",
    playbackMode: "moq",
  },
  west_d18: {
    protocol: "moq",
    ingestEndpointId: "gcp_moq_relay_d18",
    playbackMode: "moq",
  },
  gcp_d16: {
    protocol: "moq",
    ingestEndpointId: "gcp_moq_relay",
    playbackMode: "moq",
  },
};

export const BROWSER4_OUTPUT_KEYS = [
  "linode_moq",
  "linode_webrtc",
  "east_moq",
  "east_webrtc",
] as const;

export const PLAYA_D18_OUTPUT_KEYS = ["gcp_d18"] as const;

export function parseOperatorSource(raw: string | null): MediaSourceId | null {
  const value = (raw || "").trim().toLowerCase();
  if (value === "browser" || value === "browser_moq") {
    return "browser_moq";
  }
  if (value === "webcam" || value === "local") {
    return "webcam";
  }
  if (value === "dummy" || value === "cloud") {
    return "dummy";
  }
  if (value === "bbb") {
    return "bbb";
  }
  return null;
}

/** Last-mile encoder. Cloud playout ignores this and stays server ffmpeg. */
export function parseOperatorEncoder(raw: string | null): EncoderId | null {
  const value = (raw || "").trim().toLowerCase();
  if (value === "obs" || value === "openmoq") {
    return "obs";
  }
  if (value === "ffmpeg" || value === "helper") {
    return "ffmpeg";
  }
  if (value === "browser" || value === "webcodecs" || value === "browser_moq") {
    return "browser";
  }
  return null;
}

export function parseOperatorOutputs(
  raw: string | null,
  operator: string | null,
): OperatorOutputSpec[] {
  const op = (operator || "").trim().toLowerCase();
  if (op === "browser4") {
    return BROWSER4_OUTPUT_KEYS.map((key) => OPERATOR_OUTPUTS[key]);
  }
  if (op === "playa" || op === "playa-webcam" || op === "playa-file") {
    return PLAYA_D18_OUTPUT_KEYS.map((key) => OPERATOR_OUTPUTS[key]);
  }
  const keys = (raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const specs: OperatorOutputSpec[] = [];
  for (const key of keys) {
    const spec = OPERATOR_OUTPUTS[key];
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

export function operatorEndpoints(
  specs: OperatorOutputSpec[],
  nextId: () => string,
): EndpointConfig[] {
  return specs.map((spec) => ({
    id: nextId(),
    protocol: spec.protocol,
    ingestEndpointId: spec.ingestEndpointId,
    endpointUrl: "",
    vmafAvailable: false,
    serverMetricsAvailable: false,
    playbackMode: spec.playbackMode,
    playbackDvr: false,
  }));
}

export function parseOperatorSearch(search: string): {
  source: MediaSourceId | null;
  encoder: EncoderId | null;
  outputs: OperatorOutputSpec[];
  operator: string;
} {
  const trimmed = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(trimmed);
  const operator = params.get("operator");
  const op = (operator || "").trim().toLowerCase();
  let source = parseOperatorSource(params.get("source"));
  let encoder = parseOperatorEncoder(params.get("encoder"));
  if (!source && op === "browser4") {
    source = "browser_moq";
  }
  if (!source && (op === "playa" || op === "playa-webcam")) {
    source = "webcam";
  }
  if (!source && op === "playa-file") {
    source = "bbb";
  }
  if (!encoder && (op === "playa" || op === "playa-webcam")) {
    encoder = "ffmpeg";
  }
  // OBS is a last-mile encoder, not a source. Deep-link it under Webcam.
  if (encoder === "obs" && source !== "webcam") {
    source = "webcam";
  }
  // Browser is an encoder. /?source=browser and operator=browser4 stay aliases.
  if (source === "browser_moq" && !encoder) {
    encoder = "browser";
  }
  if (encoder === "browser" && source !== "webcam" && source !== "browser_moq") {
    source = source ?? "webcam";
  }
  return {
    source,
    encoder,
    outputs: parseOperatorOutputs(params.get("outputs"), operator),
    operator: op,
  };
}

/** Named recipe for /?operator=… — browser4 is MoQ vs WebRTC, not Custom. */
export function operatorBenchmarkPreset(operator: string | null): "webrtc-vs-moq" | null {
  return (operator || "").trim().toLowerCase() === "browser4" ? "webrtc-vs-moq" : null;
}
