import { useState } from "react";
import {
  GH_BYO_ENCODER_DOC,
  GH_LOCAL_PUBLISHER_DOC,
  isLocalDevApi,
  isPublicOrchestrator,
  localPublisherAgentOneLiner,
} from "./localPublisherHelp";

interface LocalPublisherSetupProps {
  apiOrigin: string;
  connected: boolean;
  compact?: boolean;
  /** Webcam last-mile setup uses shorter copy focused on the agent command. */
  variant?: "default" | "webcam";
  /** Highlight the draft-18 canary helper when the recipe hits `:14433`. */
  preferD18?: boolean;
  /** Per-browser helper binding so ffmpeg opens this user's camera. */
  publisherSession?: string;
}

export function LocalPublisherSetup({
  apiOrigin,
  connected,
  compact = false,
  variant = "default",
  preferD18: _preferD18 = false,
  publisherSession = "",
}: LocalPublisherSetupProps) {
  const [copied, setCopied] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const publicSite = isPublicOrchestrator(apiOrigin) || !isLocalDevApi(apiOrigin);
  const shortCommand = localPublisherAgentOneLiner(apiOrigin, undefined, publisherSession);

  async function copyCommand(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  if (connected) {
    return null;
  }

  return (
    <div className={`local-publisher-setup${compact ? " compact" : ""}`}>
      <p className="local-publisher-setup-lede">
        {variant === "webcam" ? (
          <>
            Start the helper on <strong>this computer</strong> so ffmpeg opens{" "}
            <strong>your</strong> camera — not a shared operator webcam.
          </>
        ) : (
          <>
            Start the local agent in another terminal, then run comparisons with{" "}
            <strong>Publisher → This machine</strong>.
          </>
        )}
      </p>
      {shortCommand ? (
        <div className="local-publisher-setup-command">
          <div className="local-publisher-setup-actions">
            <button
              type="button"
              className="secondary-button local-publisher-setup-copy"
              onClick={() => void copyCommand(shortCommand)}
            >
              {copied ? "Copied" : "Copy command"}
            </button>
            <button
              type="button"
              className="ghost-button"
              aria-expanded={showCommand}
              onClick={() => setShowCommand((open) => !open)}
            >
              {showCommand ? "Hide command" : "Show command"}
            </button>
          </div>
          {showCommand ? <pre>{shortCommand}</pre> : null}
        </div>
      ) : (
        <p className="field-hint">Preparing a helper command for this browser…</p>
      )}
      <p className="field-hint local-publisher-setup-links">
        Paste it in a terminal on this computer — any directory is fine.{" "}
        {publicSite ? (
          <>
            Cloud publish URLs:{" "}
            <a href={GH_BYO_ENCODER_DOC} target="_blank" rel="noreferrer">
              BYO encoder settings
            </a>
            .{" "}
          </>
        ) : null}
        <a href={GH_LOCAL_PUBLISHER_DOC} target="_blank" rel="noreferrer">
          Docs
        </a>
      </p>
    </div>
  );
}
