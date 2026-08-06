import { useState } from "react";
import {
  GH_BYO_ENCODER_DOC,
  GH_LOCAL_PUBLISHER_DOC,
  isLocalDevApi,
  localPublisherAgentCommand,
  localPublisherAgentOneLiner,
} from "./localPublisherHelp";

interface LocalPublisherSetupProps {
  apiOrigin: string;
  connected: boolean;
  compact?: boolean;
  /** Webcam last-mile setup uses shorter copy focused on the agent command. */
  variant?: "default" | "webcam";
}

export function LocalPublisherSetup({
  apiOrigin,
  connected,
  compact = false,
  variant = "default",
}: LocalPublisherSetupProps) {
  const [copied, setCopied] = useState(false);
  const hosted = !isLocalDevApi(apiOrigin);
  const fullCommand = localPublisherAgentCommand(apiOrigin);
  const shortCommand = localPublisherAgentOneLiner(apiOrigin);

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
          hosted ? (
            <>
              Clone the repo once, run the command below in a terminal, and leave it open. When the
              page shows <strong>Agent connected</strong>, press Start — ffmpeg on this laptop will
              open your camera.
            </>
          ) : (
            <>
              Run the local agent in another terminal — ffmpeg on this machine will capture the
              camera when you press Start.
            </>
          )
        ) : hosted ? (
          <>
            <strong>Step 1:</strong> clone the repo on this computer. <strong>Step 2:</strong> run
            the command below in a terminal and leave it open. <strong>Step 3:</strong> return here
            and wait for &quot;Agent connected&quot; before Start.
          </>
        ) : (
          <>
            Start the local agent in another terminal, then run comparisons with{" "}
            <strong>Publisher → This machine</strong>.
          </>
        )}
      </p>
      <div className="local-publisher-setup-command">
        <pre>{hosted ? fullCommand : shortCommand}</pre>
        <button
          type="button"
          className="secondary-button local-publisher-setup-copy"
          onClick={() => void copyCommand(hosted ? fullCommand : shortCommand)}
        >
          {copied ? "Copied" : "Copy command"}
        </button>
      </div>
      <p className="field-hint local-publisher-setup-links">
        {hosted ? (
          <>
            Requires ffmpeg with libx264 on your laptop. See{" "}
            <a href={GH_LOCAL_PUBLISHER_DOC} target="_blank" rel="noreferrer">
              Local publisher guide
            </a>{" "}
            · Prefer OBS or your own encoder?{" "}
            <a href={GH_BYO_ENCODER_DOC} target="_blank" rel="noreferrer">
              BYO encoder settings
            </a>
          </>
        ) : (
          <>
            Run <code>./scripts/run-local-publisher.sh</code> from the repo root.{" "}
            <a href={GH_LOCAL_PUBLISHER_DOC} target="_blank" rel="noreferrer">
              Docs
            </a>
          </>
        )}
      </p>
    </div>
  );
}
