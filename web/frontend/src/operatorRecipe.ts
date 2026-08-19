import type { MediaSourceId } from "./SourceSection";
import type { PlaybackMode } from "./playbackTypes";
import type { EndpointConfig } from "./types";

/**
 * Operator deep-links for laptop-only cases (camera + real Chrome WebTransport).
 *
 *   /?operator=browser4
 *   /?source=browser&outputs=linode_moq,linode_webrtc,east_moq,east_webrtc
 *   /?source=webcam
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
    ingestEndpointId: "linode_moq_relay",
    playbackMode: "moq",
  },
  linode_webrtc: {
    protocol: "webrtc",
    ingestEndpointId: "linode_mediamtx",
    playbackMode: "whep",
  },
  east_moq: {
    protocol: "moq",
    ingestEndpointId: "gcp_east_moq_relay",
    playbackMode: "moq",
  },
  east_webrtc: {
    protocol: "webrtc",
    ingestEndpointId: "gcp_east_mediamtx",
    playbackMode: "whep",
  },
  gcp_east_moq: {
    protocol: "moq",
    ingestEndpointId: "gcp_east_moq_relay",
    playbackMode: "moq",
  },
  gcp_east_webrtc: {
    protocol: "webrtc",
    ingestEndpointId: "gcp_east_mediamtx",
    playbackMode: "whep",
  },
};

export const BROWSER4_OUTPUT_KEYS = [
  "linode_moq",
  "linode_webrtc",
  "east_moq",
  "east_webrtc",
] as const;

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

export function parseOperatorOutputs(
  raw: string | null,
  operator: string | null,
): OperatorOutputSpec[] {
  if ((operator || "").trim().toLowerCase() === "browser4") {
    return BROWSER4_OUTPUT_KEYS.map((key) => OPERATOR_OUTPUTS[key]);
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
  outputs: OperatorOutputSpec[];
} {
  const trimmed = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(trimmed);
  const operator = params.get("operator");
  let source = parseOperatorSource(params.get("source"));
  if (!source && (operator || "").trim().toLowerCase() === "browser4") {
    source = "browser_moq";
  }
  return {
    source,
    outputs: parseOperatorOutputs(params.get("outputs"), operator),
  };
}
