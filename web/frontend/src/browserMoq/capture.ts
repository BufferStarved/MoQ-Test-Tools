export interface BrowserCapture {
  stream: MediaStream;
  hasAudio: boolean;
  stop: () => void;
}

export async function startBrowserCapture(): Promise<BrowserCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: true,
  });
  const hasAudio = stream.getAudioTracks().some((track) => track.readyState === "live");
  return {
    stream,
    hasAudio,
    stop() {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}
