import { useMemo, useState } from "react";
import type { ConfigDetailSection } from "./pipelineConfig";

interface PipelineConfigDetailsProps {
  sections: ConfigDetailSection[];
  /** Compact trigger label for the recipe / results toggle. */
  buttonLabel?: string;
  /** Start open (e.g. deep-link). Default false — opt-in details. */
  defaultOpen?: boolean;
  className?: string;
}

function sectionsToText(sections: ConfigDetailSection[]): string {
  return sections
    .map((section) => {
      const head = section.subtitle
        ? `${section.title} · ${section.subtitle}`
        : section.title;
      const body = section.rows
        .map((row) => {
          const note = row.note ? `  (${row.note})` : "";
          return `  ${row.label}: ${row.value}${note}`;
        })
        .join("\n");
      return `${head}\n${body}`;
    })
    .join("\n\n");
}

export function PipelineConfigDetails({
  sections,
  buttonLabel = "Pipeline config details",
  defaultOpen = false,
  className = "",
}: PipelineConfigDetailsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const text = useMemo(() => sectionsToText(sections), [sections]);

  if (sections.length === 0) {
    return null;
  }

  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`pipeline-config${className ? ` ${className}` : ""}`}>
      <div className="pipeline-config-toolbar">
        <button
          type="button"
          className={`pipeline-config-toggle${open ? " open" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="pipeline-config-chevron" aria-hidden="true">
            ▾
          </span>
          {buttonLabel}
        </button>
        {open && (
          <button type="button" className="secondary-button pipeline-config-copy" onClick={() => void copyDetails()}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {open && (
        <div className="pipeline-config-body">
          <p className="hint">
            Derived from the current encode ladder and target latency — what the encoder, publisher,
            ingest host, packager, and player will use for this recipe.
          </p>
          <div className="pipeline-config-grid">
            {sections.map((section) => (
              <section key={section.id} className="pipeline-config-card">
                <header>
                  <h4>{section.title}</h4>
                  {section.subtitle && <span className="pipeline-config-sub">{section.subtitle}</span>}
                </header>
                <dl>
                  {section.rows.map((row) => (
                    <div key={`${section.id}-${row.label}`} className="pipeline-config-row">
                      <dt>{row.label}</dt>
                      <dd>
                        <span>{row.value}</span>
                        {row.note && <span className="field-hint">{row.note}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
