import { useRef } from "react";
import type { FeatureFlags, WebcamDeviceInfo } from "./api";
import type { CloudEncodeHostId } from "./ingestEndpoints";
import { LocalPublisherSetup } from "./LocalPublisherSetup";
import { detectBrowserMoqCapabilities } from "./browserMoq/capabilities";
import { BrowserMoqPreview } from "./browserMoq/BrowserMoqPreview";
import { IconCamera, IconFilm } from "./Icons";
import { StatusDot } from "./StatusDot";
import { StepHeading } from "./StepHeading";
import { WebcamLivePreview } from "./WebcamLivePreview";

export type MediaSourceId = "dummy" | "bbb" | "upload" | "webcam" | "browser_moq";
export const DEVICE_BROWSER_MEDIA = "device:browser";
export type { CloudEncodeHostId };
export type EncoderId = "ffmpeg" | "obs" | "browser";

export const LOCAL_DEVICE_WEBCAM = "device:webcam";
export const OBS_OPENMOQ_MEDIA = "obs:openmoq";
export const BBB_MEDIA_PATH = "bbb.mp4";
/** Cloud playout clip length — matches color bars and the API bundled cap. */
export const CLOUD_PLAYOUT_DURATION_SEC = 60;

export function sourceModeExplainer(mediaSource: MediaSourceId): string {
  if (mediaSource === "webcam" || mediaSource === "browser_moq") {
    return "Laptop → cloud ingest: this computer’s camera (last-mile). ffmpeg (helper, default) opens the camera on the machine where you start the helper. Browser encodes in this tab. OBS is unavailable while public MoQ is draft-18.";
  }
  return "Cloud → cloud ingest: dummy bars, Big Buck Bunny, or a file already on the VM. Encodes on the cloud host with server ffmpeg — not pulled through this laptop. Last-mile engines are under Webcam.";
}

export function encoderModeExplainer(encoder: EncoderId): string {
  if (encoder === "obs") {
    return "OBS encodes. The OpenMOQ plugin is draft-16 only — it cannot publish to this site’s draft-18 relays. Use ffmpeg (helper) for MoQ.";
  }
  if (encoder === "browser") {
    return "This tab encodes (WebCodecs). MoQ and WebRTC only — no SRT or RTMP. No helper app.";
  }
  return "ffmpeg (helper) encodes every protocol on this laptop: SRT, RTMP, WebRTC (if WHIP), and MoQ. This is the default last-mile path.";
}

interface SourceSectionProps {
  mediaSource: MediaSourceId;
  onMediaSourceChange: (next: MediaSourceId) => void;
  mediaPath: string;
  mediaLabel: string;
  uploadingMedia: boolean;
  onUploadFile: (file: File) => void;
  /** Last-mile encoder. Preview stays off when OBS owns the camera. */
  encoder?: EncoderId;
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
  /** Highlight the draft-18 helper when an output is the :14433 canary. */
  preferD18Helper?: boolean;
  step?: number;
  /** Precanned recipes that already chose Webcam vs Cloud hide the mode cards. */
  hideModePicker?: boolean;
  /** Per-browser helper binding so ffmpeg opens this user's camera. */
  publisherSession?: string;
}

export function SourceSection({
  mediaSource,
  onMediaSourceChange,
  mediaPath,
  mediaLabel,
  uploadingMedia,
  onUploadFile,
  encoder = "ffmpeg",
  features,
  webcamDeviceIndex,
  onWebcamDeviceIndexChange,
  agentWebcamDevices,
  captureMinutes: _captureMinutes,
  webcamStatus,
  disabled,
  running,
  browserPreviewStream = null,
  bbbAvailable = false,
  bbbHint = null,
  preferD18Helper = false,
  step = 1,
  hideModePicker = false,
  publisherSession = "",
}: SourceSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isBrowserEngine = mediaSource === "browser_moq" || encoder === "browser";
  const isLocalWebcam = mediaSource === "webcam" || isBrowserEngine;
  const isCloudPlayout = mediaSource === "dummy" || mediaSource === "bbb" || mediaSource === "upload";
  const browserCaps = detectBrowserMoqCapabilities();
  const localAgentAvailable = features.local_publisher;
  const agentConnected = Boolean(localAgentAvailable && features.local_publisher_connected);

  function selectWebcam() {
    if (!isLocalWebcam) {
      onMediaSourceChange("webcam");
    }
  }

  function selectCloudPlayout() {
    if (!isCloudPlayout) {
      onMediaSourceChange("dummy");
    }
  }

  return (
    <div className="source-media-section source-section">
      {!hideModePicker && (
        <>
      <StepHeading
        step={step}
        title="Source"
        tip="Webcam is laptop→cloud contribution from this computer’s camera. Cloud playout / VOD encodes dummy, BBB, or a cloud file on the VM. Then pick ffmpeg or Browser under Encode when using Webcam."
      />
      <div className="source-mode-options source-mode-options-primary" role="radiogroup" aria-label="Media source">
        <label className={`source-mode-card${isLocalWebcam ? " selected" : ""}`}>
          <input
            type="radio"
            name="source-mode"
            checked={isLocalWebcam}
            disabled={disabled}
            onChange={selectWebcam}
          />
          <span className="source-mode-card-body">
            <strong>
              <IconCamera size={15} /> Webcam
            </strong>
            <span className="source-mode-card-hint">This computer → cloud ingest</span>
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
              <IconFilm size={15} /> Cloud playout / VOD
            </strong>
            <span className="source-mode-card-hint">Cloud → cloud ingest</span>
          </span>
        </label>
      </div>
      <p className="source-mode-explainer">{sourceModeExplainer(mediaSource)}</p>
        </>
      )}

      {!hideModePicker && isCloudPlayout && (
        <div className="source-mode-detail source-cloud-detail">
          <div className="source-asset-row">
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
            </label>
            {(mediaSource === "bbb" &&
              (!bbbAvailable || (bbbHint && bbbHint !== "Ready"))) ||
            (mediaSource === "upload" && mediaPath) ? (
              <p className="field-hint source-asset-hint">
                {mediaSource === "bbb" &&
                  (bbbAvailable
                    ? bbbHint && bbbHint !== "Ready"
                      ? bbbHint
                      : null
                    : "bbb.mp4 is not on this host yet.")}
                {mediaSource === "upload" && mediaPath ? mediaLabel : null}
              </p>
            ) : null}
          </div>
          {mediaSource === "upload" && (
            <div className="button-row source-upload-row">
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
        </div>
      )}

      {isLocalWebcam && !isBrowserEngine && (
        <div className="source-mode-detail webcam-detail">
          <div className="webcam-detail-main">
            <div className="webcam-detail-controls">
              {agentConnected ? (
                <>
                  <StatusDot
                    tone="ok"
                    label="Agent Connected"
                    className="webcam-detail-connected agent-connected-badge"
                  />
                  {encoder === "obs" && (
                    <p className="field-hint">
                      OBS owns the scene. Pick ffmpeg under Encode if you want this helper
                      to open the camera instead.
                    </p>
                  )}
                  {agentWebcamDevices.length > 0 && encoder !== "obs" && (
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
                  {features.local_publisher_whip === false && (
                    <p className="field-hint">
                      This laptop cannot publish WebRTC yet. Use SRT, RTMP, or MoQ, or switch
                      to Cloud playout or Webcam + Browser.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <StatusDot
                    tone="warn"
                    label="Helper not running"
                    className="agent-waiting-badge"
                  />
                  <p className="field-hint">
                    The site is fine. Switch to Cloud playout or Webcam + Browser to run a
                    comparison now — those work in this page without a helper app.
                  </p>
                  <LocalPublisherSetup
                    apiOrigin={window.location.origin}
                    connected={false}
                    compact
                    variant="webcam"
                    preferD18={preferD18Helper}
                    publisherSession={publisherSession}
                  />
                </>
              )}
            </div>
            {agentConnected && encoder !== "obs" ? (
              <WebcamLivePreview active={isLocalWebcam} running={running} deviceIndex={webcamDeviceIndex} />
            ) : null}
          </div>
        </div>
      )}

      {isLocalWebcam && isBrowserEngine && (
        <div className="source-mode-detail webcam-detail">
          <div className={`webcam-detail-main${browserPreviewStream ? "" : " webcam-detail-main-compact"}`}>
            <div className="webcam-detail-controls">
              <StatusDot
                tone={browserCaps.ok ? "ok" : "warn"}
                label={browserCaps.ok ? "This tab can publish" : "This browser cannot publish yet"}
              />
              {webcamStatus && <span className="field-hint">{webcamStatus}</span>}
            </div>
            {browserPreviewStream ? (
              <BrowserMoqPreview stream={browserPreviewStream} active={isBrowserEngine} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
