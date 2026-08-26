interface GoLiveButtonProps {
  visible: boolean;
  disabled?: boolean;
  title?: string;
  onGoLive: () => void;
}

/** Optional operator drain-to-live. Hidden on WebRTC (already live). */
export function GoLiveButton({ visible, disabled, title, onGoLive }: GoLiveButtonProps) {
  if (!visible) {
    return null;
  }
  return (
    <button
      type="button"
      className="ghost-button go-live-button"
      disabled={disabled}
      title={title ?? "Seek to the live edge. May hitch. Refuses a frozen playhead or buffer hole."}
      onClick={onGoLive}
    >
      Go Live
    </button>
  );
}
