import { useEffect, useMemo, useState } from "react";
import { fetchUpload, subscribeToUpload } from "./api";
import { StreamPlayer } from "./StreamPlayer";
import { deriveEncodeAnchorEpoch } from "./metricModel";
import { playbackGateForJob } from "./playbackGate";
import {
  ingestEndpointIdForPreset,
  moqDraftForIngest,
  moqPinTlsCertForIngest,
} from "./ingestEndpoints";
import {
  defaultPlaybackModeForProtocol,
  moqDefaultsFromPublishUrl,
  proxiedMoqFingerprintUrl,
  relayWebTransportUrl,
} from "./playbackUrls";
import type { PlaybackMode } from "./playbackTypes";
import type { UploadJob, UploadSample } from "./types";

/**
 * Headless job player for the matrix harness (and API-only runs).
 * Mounts the same StreamPlayer + usePlaybackMetricsReporter as the site UI
 * so CSVs get real playback_* / e2e — never synthetic numbers.
 */
export function HarnessPage({ jobId, playback }: { jobId: string; playback: string }) {
  const [job, setJob] = useState<UploadJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modeOverride, setModeOverride] = useState<PlaybackMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchUpload(jobId)
      .then((next) => {
        if (!cancelled) {
          setJob(next);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    const stop = subscribeToUpload(
      jobId,
      (sample) => {
        if (cancelled) {
          return;
        }
        setJob((current) =>
          current
            ? { ...current, samples: [...current.samples, sample] }
            : current,
        );
      },
      (status) => {
        if (cancelled) {
          return;
        }
        setJob((current) =>
          current
            ? { ...current, ...status, status: status.status as UploadJob["status"] }
            : current,
        );
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [jobId]);

  const ingestEndpointId = useMemo(
    () => ingestEndpointIdForPreset(job?.preset_id || ""),
    [job?.preset_id],
  );
  const moq = useMemo(() => {
    if (!job || job.protocol !== "moq") {
      return { relay: "", fingerprint: "", namespace: "" };
    }
    const defaults = moqDefaultsFromPublishUrl(job.endpoint_url);
    return {
      relay: relayWebTransportUrl(job.endpoint_url) || defaults.relayUrl,
      fingerprint: proxiedMoqFingerprintUrl(job.endpoint_url),
      namespace: job.moq_namespace || defaults.namespace,
    };
  }, [job]);

  const gate = playbackGateForJob(job ?? undefined, !job);
  const samples: UploadSample[] = job?.samples ?? [];

  if (error) {
    return <div className="player-surface">Harness: {error}</div>;
  }
  if (!job) {
    return <div className="player-surface">Harness: loading job…</div>;
  }

  const requested = (playback ||
    defaultPlaybackModeForProtocol(job.protocol, ingestEndpointId)) as PlaybackMode;
  const mode = modeOverride || requested;

  return (
    <div style={{ minHeight: "100vh", background: "#0b1220", color: "#e5e7eb", padding: 16 }}>
      <StreamPlayer
        title={`Harness ${job.protocol}`}
        compactHeader
        protocol={job.protocol}
        endpointUrl={job.endpoint_url}
        ingestEndpointId={ingestEndpointId}
        playbackMode={mode}
        onPlaybackModeChange={(next) => {
          if (next !== mode) {
            setModeOverride(next);
          }
        }}
        moqRelayUrl={moq.relay}
        moqFingerprintUrl={moq.fingerprint}
        moqNamespace={moq.namespace}
        zixiStreamId={job.zixi_stream_id ?? undefined}
        zixiPlaybackStreamId={job.zixi_playback_stream_id ?? undefined}
        playbackGate={gate}
        jobId={job.id}
        encodeStartedAtEpoch={deriveEncodeAnchorEpoch(job, samples)}
        packagerTransitMs={job.packager_transit_ms ?? null}
        deliveryMediaOriginSec={job.delivery_media_origin_sec ?? null}
        jobStatus={job.status}
        jobError={job.error}
        benchmarkLoading={job.status === "running"}
        encodeDurationSec={job.duration_sec}
        targetLatencyMs={job.target_latency_ms ?? 800}
        encodeLadder={job.encode_ladder ?? undefined}
        moqDraftVersion={moqDraftForIngest(ingestEndpointId)}
        moqPinTlsCert={moqPinTlsCertForIngest(ingestEndpointId)}
      />
    </div>
  );
}
