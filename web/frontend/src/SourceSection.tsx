import { useRef } from "react";
import type { FeatureFlags, WebcamDeviceInfo } from "./api";
import type { CloudEncodeHostId } from "./ingestEndpoints";
import { LocalPublisherSetup } from "./LocalPublisherSetup";
import { detectBrowserMoqCapabilities } from "./browserMoq/capabilities";
import { BrowserMoqPreview } from "./browserMoq/BrowserMoqPreview";
import { IconCamera, IconCpu, IconFilm } from "./Icons";
import { StatusDot } from "./StatusDot";
import { StepHeading } from "./StepHeading";
import { WebcamLivePreview } from "./WebcamLivePreview";

export type MediaSourceId = "dummy" | "bbb" | "upload" | "webcam" | "browser_moq";
export const DEVICE_BROWSER_MEDIA = "device:browser";
export type { CloudEncodeHostId };
export type EncoderId = "ffmpeg" | "obs" | "wowza";

export const LOCAL_DEVICE_WEBCAM = "device:webcam";
export const BBB_MEDIA_PATH = "bbb.mp4";
/** Cloud playout clip length — matches color bars and the API bundled cap. */
export const CLOUD_PLAYOUT_DURATION_SEC = 60;

export function sourceModeExplainer(mediaSource: MediaSourceId): string {
  if (mediaSource === "webcam") {
    return "Captures this laptop’s camera. Encodes here with a small helper app. Pick this for last-mile or OBS Virtual Camera.";
  }
  if (mediaSource === "browser_moq") {
    return "Captures this laptop’s camera in this tab. Encodes in the browser. Pick this if you do not have a helper app — no special ffmpeg required.";
  }
  return "Plays color bars or Big Buck Bunny on the server. Encodes in the cloud. Pick this to compare protocols without a camera.";
}

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
  captureMinutes: _captureMinutes,
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
  const isCloudPlayout = mediaSource === "dummy" || mediaSource === "bbb" || mediaSource === "upload";
  const browserCaps = detectBrowserMoqCapabilities();
  const localAgentAvailable = features.local_publisher;

  function selectCloudPlayout() {
    if (!isCloudPlayout) {
      onMediaSourceChange("dummy");
    }
  }

  return (
    <div className="source-media-section source-section">
      <StepHeading
        step={1}
        title="Source"
        tip="Webcam uses this laptop’s helper app. Browser captures in this tab. Cloud playout is dummy bars or BBB on the server."
      />
      <div className="source-mode-options source-mode-options-primary" role="radiogroup" aria-label="Media source">
        <label className={`source-mode-card${isLocalWebcam ? " selected" : ""}`}>
          <input
            type="radio"
            name="source-mode"
            checked={isLocalWebcam}
            disabled={disabled}
            onChange={() => onMediaSourceChange("webcam")}
          />
          <span className="source-mode-card-body">
            <strong>
              <IconCamera size={15} /> Webcam
            </strong>
            <span className="source-mode-card-hint">This laptop + helper app</span>
          </span>
        </label>
        <label className={`source-mode-card${isBrowserMoq ? " selected" : ""}`}>
          <input
            type="radio"
            name="source-mode"
            checked={isBrowserMoq}
            disabled={disabled || !browserCaps.ok}
            onChange={() => onMediaSourceChange("browser_moq")}
          />
          <span className="source-mode-card-body">
            <strong>
              <IconCpu size={15} /> Browser
            </strong>
            <span className="source-mode-card-hint">This tab, no helper app</span>
            {!browserCaps.ok && <span className="field-hint">{browserCaps.reason}</span>}
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
            <span className="source-mode-card-hint">Dummy / BBB on the server</span>
          </span>
        </label>
      </div>
      <p className="source-mode-explainer">{sourceModeExplainer(mediaSource)}</p>

      {isCloudPlayout && (
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

      {isLocalWebcam && (
        <div className="source-mode-detail webcam-detail">
          <div className="webcam-detail-main">
            <div className="webcam-detail-controls">
              {localAgentAvailable && features.local_publisher_connected ? (
                <>
                  <StatusDot
                    tone="ok"
                    label="Helper app connected"
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
                  {features.local_publisher_whip === false && (
                    <p className="field-hint">
                      This laptop cannot publish WebRTC yet. Use SRT, RTMP, or MoQ, or switch
                      to Cloud playout or Browser.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <StatusDot tone="warn" label="Webcam helper not running yet" />
                  <p className="field-hint">
                    The site is fine. Switch to Cloud playout or Browser to run a comparison
                    now — those work in this page without a helper app.
                  </p>
                  <LocalPublisherSetup
                    apiOrigin={window.location.origin}
                    connected={false}
                    compact
                    variant="webcam"
                  />
                </>
              )}
            </div>
            {localAgentAvailable && features.local_publisher_connected ? (
              <WebcamLivePreview active={isLocalWebcam} running={running} deviceIndex={webcamDeviceIndex} />
            ) : null}
          </div>
        </div>
      )}

      {isBrowserMoq && (
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
              <BrowserMoqPreview stream={browserPreviewStream} active={isBrowserMoq} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
