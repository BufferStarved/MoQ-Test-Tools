import { useRef } from "react";
import type { FeatureFlags, WebcamDeviceInfo } from "./api";
import type { CloudEncodeHostId } from "./ingestEndpoints";
import { LocalPublisherSetup } from "./LocalPublisherSetup";
import { detectBrowserMoqCapabilities } from "./browserMoq/capabilities";
import { BrowserMoqPreview } from "./browserMoq/BrowserMoqPreview";
import { IconCamera, IconCpu, IconFilm, IconLaptop } from "./Icons";
import { StatusDot } from "./StatusDot";
import { StepHeading } from "./StepHeading";
import { WebcamLivePreview } from "./WebcamLivePreview";

export type MediaSourceId = "dummy" | "bbb" | "upload" | "webcam" | "browser_moq";
export const DEVICE_BROWSER_MEDIA = "device:browser";
export type { CloudEncodeHostId };
export type EncoderId = "ffmpeg" | "obs" | "wowza";

export const LOCAL_DEVICE_WEBCAM = "device:webcam";
export const BBB_MEDIA_PATH = "bbb.mp4";

interface SourceSectionProps {
  mediaSource: MediaSourceId;
  onMediaSourceChange: (next: MediaSourceId) => void;
  mediaPath: string;
  mediaLabel: string;
  uploadingMedia: boolean;
  onUploadFile: (file: File) => void;
  encoder: EncoderId;
  onEncoderChange: (encoder: EncoderId) => void;
  features: FeatureFlags;
  webcamDeviceIndex: string;
  onWebcamDeviceIndexChange: (index: string) => void;
  agentWebcamDevices: WebcamDeviceInfo[];
  captureMinutes: number;
  webcamStatus: string | null;
  disabled: boolean;
  /** A run is currently in flight — the local agent needs the camera exclusively. */
  running: boolean;
  browserPreviewStream?: MediaStream | null;
  bbbAvailable?: boolean;
  bbbHint?: string | null;
}

export function SourceSection({
  mediaSource,
  onMediaSourceChange,
  mediaPath,
  mediaLabel,
  uploadingMedia,
  onUploadFile,
  encoder: _encoder,
  onEncoderChange: _onEncoderChange,
  features,
  webcamDeviceIndex,
  onWebcamDeviceIndexChange,
  agentWebcamDevices,
  captureMinutes,
  webcamStatus,
  disabled,
  running,
  browserPreviewStream = null,
  bbbAvailable = false,
  bbbHint = null,
}: SourceSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isLocalWebcam = mediaSource === "webcam";
  const isBrowserMoq = mediaSource === "browser_moq";
  const isLiveCamera = isLocalWebcam || isBrowserMoq;
  const isCloudPlayout = !isLiveCamera;
  const browserCaps = detectBrowserMoqCapabilities();
  const localAgentAvailable = features.local_publisher;

  function selectCloudPlayout() {
    if (!isCloudPlayout) {
      onMediaSourceChange("dummy");
    }
  }

  function selectWebcam() {
    if (isLiveCamera) {
      return;
    }
    onMediaSourceChange(browserCaps.ok ? "browser_moq" : "webcam");
  }

  function selectLiveEncode(next: "browser" | "local") {
    if (next === "browser") {
      onMediaSourceChange("browser_moq");
      return;
    }
    onMediaSourceChange("webcam");
  }

  return (
    <div className="source-media-section source-section">
      <StepHeading
        step={1}
        title="Source"
        tip="Choose a live camera or a cloud playout (a file encoded live on the API host). A webcam then asks where to encode — Browser or this computer."
      />
      <div className="source-mode-options source-mode-options-primary" role="radiogroup" aria-label="Media source">
        <label className={`source-mode-card${isLiveCamera ? " selected" : ""}`}>
          <input
            type="radio"
            name="source-mode"
            checked={isLiveCamera}
            disabled={disabled}
            onChange={selectWebcam}
          />
          <span className="source-mode-card-body">
            <strong>
              <IconCamera size={15} /> Webcam
            </strong>
            <span className="field-hint">This machine’s camera</span>
          </span>
        </label>
        <label className={`source-mode-card${isCloudPlayout ? " selected" : ""}`}>
          <input
            type="radio"
            name="source-mode"
            checked={isCloudPlayout}
            disabled={disabled}
            onChange={selectCloudPlayout}
          />
          <span className="source-mode-card-body">
            <strong>
              <IconFilm size={15} /> Cloud playout
            </strong>
            <span className="field-hint">File encoded live on the API host</span>
          </span>
        </label>
      </div>

      {isLiveCamera && (
        <div className="encode-location-block">
          <p className="encode-location-lede">Where should this camera encode?</p>
          <div className="source-mode-options encode-location-options" role="radiogroup" aria-label="Encode location">
            <label className={`source-mode-card${isBrowserMoq ? " selected" : ""}`}>
              <input
                type="radio"
                name="live-encode-location"
                checked={isBrowserMoq}
                disabled={disabled || !browserCaps.ok}
                onChange={() => selectLiveEncode("browser")}
              />
              <span className="source-mode-card-body">
                <strong>
                  <IconCpu size={15} /> Browser
                </strong>
                <span className="field-hint">
                  {browserCaps.ok
                    ? "MoQ or WebRTC with WebCodecs"
                    : browserCaps.reason}
                </span>
              </span>
            </label>
            <label className={`source-mode-card${isLocalWebcam ? " selected" : ""}`}>
              <input
                type="radio"
                name="live-encode-location"
                checked={isLocalWebcam}
                disabled={disabled || !localAgentAvailable}
                onChange={() => selectLiveEncode("local")}
              />
              <span className="source-mode-card-body">
                <strong>
                  <IconLaptop size={15} /> This computer
                </strong>
                <span className="field-hint">
                  {localAgentAvailable
                    ? "FFMPEG - SRT, RTMP, MOQ, WebRTC"
                    : "Needs the local publisher agent (not enabled here)."}
                </span>
              </span>
            </label>
          </div>
          <p className="field-hint source-roadmap-hint">OBS, Wowza, and AWS ingest are next.</p>
        </div>
      )}

      {isCloudPlayout && (
        <div className="source-mode-detail">
          <label>
            Asset
            <select
              value={mediaSource}
              disabled={disabled}
              onChange={(e) => onMediaSourceChange(e.target.value as MediaSourceId)}
            >
              <option value="dummy">Default Color Bars</option>
              <option value="bbb">Big Buck Bunny</option>
              <option value="upload">Upload your own file…</option>
            </select>
            {mediaSource === "dummy" && <span className="field-hint">60s color bars with time counter</span>}
            {mediaSource === "bbb" && (
              <span className="field-hint">
                {bbbAvailable
                  ? "Blender Foundation short — encoded live on the API host"
                  : bbbHint || "Place bbb.mp4 next to dummy.mp4, or run scripts/fetch-bbb.sh"}
              </span>
            )}
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
          <p className="field-hint">
            Encoded with ffmpeg on the API host (GCP us-central1). Each output’s Destination
            chooses the ingest independently.
          </p>
          <p className="field-hint source-roadmap-hint">OBS, Wowza, and AWS ingest are next.</p>
        </div>
      )}

      {isLocalWebcam && localAgentAvailable && (
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
            <WebcamLivePreview active={isLocalWebcam} running={running} deviceIndex={webcamDeviceIndex} />
          </div>
        </div>
      )}

      {isBrowserMoq && (
        <div className="source-mode-detail webcam-detail">
          <div className={`webcam-detail-main${browserPreviewStream ? "" : " webcam-detail-main-compact"}`}>
            <div className="webcam-detail-controls">
              <StatusDot
                tone={browserCaps.ok ? "ok" : "warn"}
                label={
                  browserCaps.ok
                    ? `Ready — auto-stops after ${captureMinutes} min`
                    : "Browser cannot publish yet"
                }
              />
              {webcamStatus && <span className="field-hint">{webcamStatus}</span>}
            </div>
            {browserPreviewStream ? (
              <BrowserMoqPreview stream={browserPreviewStream} active={isBrowserMoq} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
