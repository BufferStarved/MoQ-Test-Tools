import { useEffect, useRef } from "react";

interface WebcamPreviewProps {
  stream: MediaStream | null;
  className?: string;
}

/**
 * Self-binding webcam preview. Attaches the MediaStream in an effect instead
 * of relying on a parent-held ref, so the preview keeps rendering no matter
 * where (or how many times) it mounts — e.g. both inside the collapsible run
 * recipe and in the persistent strip shown during a live benchmark.
 */
export function WebcamPreview({ stream, className = "webcam-preview" }: WebcamPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    if (stream) {
      void video.play().catch(() => undefined);
    }
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return <video ref={videoRef} className={className} muted playsInline autoPlay />;
}
