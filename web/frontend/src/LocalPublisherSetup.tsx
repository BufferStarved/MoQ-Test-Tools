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
  /** Highlight the draft-18 canary helper when the recipe hits `:14433`. */
  preferD18?: boolean;
}

export function LocalPublisherSetup({
  apiOrigin,
  connected,
  compact = false,
  variant = "default",
  preferD18: _preferD18 = false,
}: LocalPublisherSetupProps) {
  const [copied, setCopied] = useState<"helper" | "dev" | null>(null);
  const hosted = !isLocalDevApi(apiOrigin);
  const helperCommand = localPublisherAgentCommand(apiOrigin);
  const shortCommand = localPublisherAgentOneLiner(apiOrigin);

  async function copyCommand(id: "helper" | "dev", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
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
              Optional: only if you want Webcam + ffmpeg. Cloud playout and Webcam +
              Browser already work. One helper covers MoQ draft-18 and SRT / RTMP /
              WebRTC — do not start a second <code>main</code> helper.
            </>
          ) : (
            <>Optional: start the local helper in another terminal for Webcam.</>
          )
        ) : hosted ? (
          <>
            <strong>Step 1:</strong> clone the helper below. <strong>Step 2:</strong> run it in a
            terminal and leave it open. <strong>Step 3:</strong> return here and wait for
            &quot;Agent connected&quot; before Start. One agent can compare MoQ draft-18
            with SRT / RTMP / WebRTC.
          </>
        ) : (
          <>
            Start the local agent in another terminal, then run comparisons with{" "}
            <strong>Publisher → This machine</strong>.
          </>
        )}
      </p>
      {hosted ? (
        <div className="local-publisher-setup-recipes">
          <HelperRecipe
            id="helper"
            title="Laptop helper"
            detail="One process: MoQ draft-18 (moq5-fmp4-publish · :14433) plus SRT, RTMP, and WebRTC. Stop any leftover main helper first."
            command={helperCommand}
            recommended
            copied={copied === "helper"}
            onCopy={() => void copyCommand("helper", helperCommand)}
          />
        </div>
      ) : (
        <div className="local-publisher-setup-command">
          <pre>{shortCommand}</pre>
          <button
            type="button"
            className="secondary-button local-publisher-setup-copy"
            onClick={() => void copyCommand("dev", shortCommand)}
          >
            {copied === "dev" ? "Copied" : "Copy command"}
          </button>
        </div>
      )}
      <p className="field-hint local-publisher-setup-links">
        {hosted ? (
          <>
            Requires ffmpeg with libx264 on your laptop (default last-mile encoder). See{" "}
            <a href={GH_LOCAL_PUBLISHER_DOC} target="_blank" rel="noreferrer">
              Local publisher guide
            </a>{" "}
            · OBS is unavailable on this site (plugin is draft-16; public MoQ is draft-18). BYO
            publish URLs:{" "}
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

function HelperRecipe({
  title,
  detail,
  command,
  recommended,
  copied,
  onCopy,
}: {
  id: string;
  title: string;
  detail: string;
  command: string;
  recommended: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className={`local-publisher-recipe${recommended ? " recommended" : ""}`}>
      <div className="local-publisher-recipe-head">
        <strong>{title}</strong>
        {recommended ? <span className="local-publisher-recipe-badge">This recipe</span> : null}
      </div>
      <p className="field-hint">{detail}</p>
      <div className="local-publisher-setup-command">
        <pre>{command}</pre>
        <button type="button" className="secondary-button local-publisher-setup-copy" onClick={onCopy}>
          {copied ? "Copied" : "Copy command"}
        </button>
      </div>
    </div>
  );
}
