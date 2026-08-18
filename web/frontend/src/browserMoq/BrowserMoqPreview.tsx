import { useEffect, useRef } from "react";
import { IconCpu } from "../Icons";

interface BrowserMoqPreviewProps {
  stream: MediaStream | null;
  active: boolean;
}

export function BrowserMoqPreview({ stream, active }: BrowserMoqPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = active ? stream : null;
    if (active && stream) {
      void video.play().catch(() => undefined);
    }
    return () => {
      video.srcObject = null;
    };
  }, [stream, active]);

  return (
    <div className="webcam-live-preview">
      {active && stream ? (
        <video ref={videoRef} muted playsInline autoPlay className="webcam-live-preview-video" />
      ) : (
        <div className="webcam-live-preview-handed-off">
          <IconCpu size={18} />
          <span>Camera stays in the browser — no terminal agent.</span>
        </div>
      )}
    </div>
  );
}
