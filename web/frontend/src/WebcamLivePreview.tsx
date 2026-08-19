import { useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconCamera } from "./Icons";

interface WebcamLivePreviewProps {
  /** Show and try to acquire the camera. */
  active: boolean;
  /** A run is in flight — the local publisher agent needs exclusive device
   * access, so the browser must not be holding the camera open too. */
  running: boolean;
  deviceIndex?: string;
}

function formatWallClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Best-effort live self-view for the webcam source. The actual publish path
 * always goes through the local agent's own ffmpeg capture (AVFoundation /
 * V4L2) — the browser tab is never in that data path — so this preview is
 * *only* safe to hold open while idle. The moment a run starts we stop every
 * track so the OS can hand the physical device to ffmpeg exclusively;
 * without that hand-off, two consumers fighting for one camera commonly
 * fails outright on macOS/Linux. See stopForRun(), called from handleStart.
 *
 * The preview is not mirrored (OBS Virtual Camera already has the correct
 * orientation; scaleX(-1) flipped burned-in timestamps). The overlay is
 * wall-clock capture time on this laptop — not Unix-epoch + PTS.
 */
export function WebcamLivePreview({ active, running }: WebcamLivePreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState(() => formatWallClock(new Date()));

  useEffect(() => {
    if (!active || running) {
      return;
    }
    const timer = window.setInterval(() => {
      setClock(formatWallClock(new Date()));
    }, 250);
    return () => window.clearInterval(timer);
  }, [active, running]);

  useEffect(() => {
    if (!active || running) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setReady(false);
      return;
    }

    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 640, height: 360 }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setReady(true);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Camera unavailable");
        }
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setReady(false);
    };
  }, [active, running]);

  if (!active) {
    return null;
  }

  return (
    <div className="webcam-live-preview">
      {running ? (
        <div className="webcam-live-preview-handed-off">
          <IconCamera size={18} />
          <span>Camera handed off to the local agent for this run</span>
        </div>
      ) : error ? (
        <div className="webcam-live-preview-error">
          <IconAlertTriangle size={18} />
          <span>Browser preview unavailable ({error}) — the agent can still open the camera directly.</span>
        </div>
      ) : (
        <>
          <video ref={videoRef} autoPlay muted playsInline className="webcam-live-preview-video" />
          {ready && (
            <div className="webcam-preview-clock" title="Wall-clock on this laptop (preview only)">
              <span className="webcam-preview-clock-label">wall clock</span>
              {clock}
            </div>
          )}
          {!ready && <div className="webcam-live-preview-loading">Starting camera preview…</div>}
        </>
      )}
    </div>
  );
}
