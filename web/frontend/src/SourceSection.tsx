import { useRef } from "react";
import type { FeatureFlags, WebcamDeviceInfo } from "./api";
import { LocalPublisherSetup } from "./LocalPublisherSetup";
import { IconCamera, IconFilm } from "./Icons";
import { StatusDot } from "./StatusDot";
import { StepHeading } from "./StepHeading";
import { WebcamLivePreview } from "./WebcamLivePreview";

export type MediaSourceId = "dummy" | "bbb" | "upload" | "webcam";
export type CloudEncodeHostId = "gcp" | "linode" | "aws";
export type EncoderId = "ffmpeg" | "obs" | "wowza";

export const LOCAL_DEVICE_WEBCAM = "device:webcam";

/** Purely informational today — every cloud encode runs on the GCP API host.
 * Kept as a real picker (not a static label) so adding a second cloud encode
 * host later is a backend wiring change, not a UI rebuild. */
const CLOUD_ENCODE_HOSTS: { id: CloudEncodeHostId; label: string; available: boolean }[] = [
  { id: "gcp", label: "GCP us-central1 (this API host)", available: true },
  { id: "linode", label: "Linode", available: false },
  { id: "aws", label: "AWS", available: false },
];

/** ffmpeg is the only encoder actually wired up today — OBS/Wowza are real
 * picker entries (not just a label) so turning them on later is additive. */
const ENCODERS: { id: EncoderId; label: string; available: boolean }[] = [
  { id: "ffmpeg", label: "ffmpeg", available: true },
  { id: "obs", label: "OBS Studio", available: false },
  { id: "wowza", label: "Wowza", available: false },
];

interface SourceSectionProps {
  mediaSource: MediaSourceId;
  onMediaSourceChange: (next: MediaSourceId) => void;
  mediaPath: string;
  mediaLabel: string;
  uploadingMedia: boolean;
  onUploadFile: (file: File) => void;
  encoder: EncoderId;
  onEncoderChange: (encoder: EncoderId) => void;
  encodeCloudHost: CloudEncodeHostId;
  onEncodeCloudHostChange: (host: CloudEncodeHostId) => void;
  features: FeatureFlags;
  webcamDeviceIndex: string;
  onWebcamDeviceIndexChange: (index: string) => void;
  agentWebcamDevices: WebcamDeviceInfo[];
  captureMinutes: number;
  webcamStatus: string | null;
  disabled: boolean;
  /** A run is currently in flight — the local agent needs the camera exclusively. */
  running: boolean;
}

export function SourceSection({
  mediaSource,
  onMediaSourceChange,
  mediaPath,
  mediaLabel,
  uploadingMedia,
  onUploadFile,
  encoder,
  onEncoderChange,
  encodeCloudHost,
  onEncodeCloudHostChange,
  features,
  webcamDeviceIndex,
  onWebcamDeviceIndexChange,
  agentWebcamDevices,
  captureMinutes,
  webcamStatus,
  disabled,
  running,
}: SourceSectionProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isWebcam = mediaSource === "webcam";
  const isVod = !isWebcam;
  const webcamAvailable = features.local_publisher;

  function selectVod() {
    if (isWebcam) {
      onMediaSourceChange("dummy");
    }
  }

  function selectWebcam() {
    if (!webcamAvailable || isWebcam) {
      return;
    }
    onMediaSourceChange("webcam");
  }

  return (
    <div className="source-media-section source-section">
      <StepHeading
        step={1}
        title="Source"
        tip="Choose what every output will publish from — a live webcam via the local agent, or a VOD asset (color bars or your own file). Same source feeds all protocols below."
      />
      <div className="source-mode-options" role="radiogroup" aria-label="Media source">
        <label className={`source-mode-card${isWebcam ? " selected" : ""}`}>
          <input
            type="radio"
            name="source-mode"
            checked={isWebcam}
            disabled={disabled || !webcamAvailable}
            onChange={selectWebcam}
          />
          <span className="source-mode-card-body">
            <strong>
              <IconCamera size={15} /> Webcam
            </strong>
            {!webcamAvailable && (
              <span className="field-hint source-mode-unavailable">
                Needs the local publisher agent (not enabled here).
              </span>
            )}
          </span>
        </label>
        <label className={`source-mode-card${isVod ? " selected" : ""}`}>
          <input
            type="radio"
            name="source-mode"
            checked={isVod}
            disabled={disabled}
            onChange={selectVod}
          />
          <span className="source-mode-card-body">
            <strong>
              <IconFilm size={15} /> VOD asset
            </strong>
          </span>
        </label>
      </div>

      {isVod && (
        <div className="source-mode-detail">
          <label>
            Asset
            <select
              value={mediaSource}
              disabled={disabled}
              onChange={(e) => onMediaSourceChange(e.target.value as MediaSourceId)}
            >
              <option value="dummy">Default Color Bars</option>
              <option value="bbb" disabled>
                Big Buck Bunny (coming soon)
              </option>
              <option value="upload">Upload your own file…</option>
            </select>
            {mediaSource === "dummy" && <span className="field-hint">60s color bars with time counter</span>}
            {mediaSource === "upload" && (
              <span className="field-hint">{mediaPath ? `Using: ${mediaLabel}` : "Choose a file to upload"}</span>
            )}
          </label>
          {mediaSource === "upload" && (
            <div className="button-row" style={{ marginTop: 0 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,.mp4,.mov,.mkv,.webm"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) {
                    onUploadFile(file);
                  }
                }}
              />
              <button
                type="button"
                className="secondary-button"
                disabled={disabled || uploadingMedia}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadingMedia ? "Uploading…" : mediaPath ? "Choose another file" : "Choose file"}
              </button>
            </div>
          )}
          <label>
            Encoder
            <select
              value={encoder}
              disabled={disabled}
              onChange={(e) => onEncoderChange(e.target.value as EncoderId)}
            >
              {ENCODERS.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.label}
                  {!item.available ? " (coming soon)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cloud encode host
            <select
              value={encodeCloudHost}
              disabled={disabled}
              onChange={(e) => onEncodeCloudHostChange(e.target.value as CloudEncodeHostId)}
            >
              {CLOUD_ENCODE_HOSTS.map((host) => (
                <option key={host.id} value={host.id} disabled={!host.available}>
                  {host.label}
                  {!host.available ? " (coming soon)" : ""}
                </option>
              ))}
            </select>
            <span className="field-hint">GCP us-central1 only for now — more regions soon.</span>
          </label>
        </div>
      )}

      {isWebcam && webcamAvailable && (
        <div className="source-mode-detail webcam-detail">
          <div className="webcam-detail-main">
            <div className="webcam-detail-controls">
              {features.local_publisher_connected ? (
                <>
                  <StatusDot
                    tone="ok"
                    label={`Agent connected — auto-stops after ${captureMinutes} min`}
                    className="webcam-detail-connected"
                  />
                  {agentWebcamDevices.length > 0 && (
                    <label className="webcam-device-picker">
                      Camera
                      <select
                        value={webcamDeviceIndex}
                        disabled={disabled}
                        onChange={(e) => onWebcamDeviceIndexChange(e.target.value)}
                      >
                        <option value="">Auto (default camera)</option>
                        {agentWebcamDevices.map((device) => (
                          <option key={device.index} value={String(device.index)}>
                            {device.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {webcamStatus && <span className="field-hint">{webcamStatus}</span>}
                </>
              ) : (
                <>
                  <StatusDot tone="warn" label="Agent not connected" />
                  <LocalPublisherSetup
                    apiOrigin={window.location.origin}
                    connected={false}
                    compact
                    variant="webcam"
                  />
                  <p className="field-hint webcam-detail-blocked">Start stays disabled until it connects.</p>
                </>
              )}
            </div>
            <WebcamLivePreview active={isWebcam} running={running} deviceIndex={webcamDeviceIndex} />
          </div>
        </div>
      )}
    </div>
  );
}
