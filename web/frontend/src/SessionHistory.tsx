import { useCallback, useEffect, useState } from "react";
import type { ResultSummary } from "./types";
import {
  loadSessionHistory,
  loadSessionSummaries,
  sessionProtocolSummary,
  sessionTimeLabel,
  type SessionGroup,
} from "./sessionGroups";

interface SessionHistoryProps {
  onSelect: (summaries: ResultSummary[], labels: string[], key: string) => void;
  /** Currently displayed session key (comparison_id or single:filename). */
  selectedKey?: string | null;
  /** Bump to force a re-fetch after a new comparison finishes. */
  refreshToken?: number;
}

export function SessionHistory({ onSelect, selectedKey = null, refreshToken }: SessionHistoryProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionGroup[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const groups = await loadSessionHistory();
      setSessions(groups);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Historical sessions live server-side (results/) — re-fetch whenever a
    // run finishes so the newest one shows up without a manual refresh.
    setLoaded(false);
  }, [refreshToken]);

  useEffect(() => {
    // Load quietly when a session is selected so the collapsed trigger can show
    // "Jul 19 · SRT · MoQ" without forcing the picker open.
    if (selectedKey && !loaded) {
      void fetchSessions();
    }
  }, [selectedKey, loaded, fetchSessions]);

  const selectedGroup = selectedKey
    ? (sessions.find((group) => group.key === selectedKey) ?? null)
    : null;

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !loaded) {
      await fetchSessions();
    }
  }

  async function selectSession(group: SessionGroup) {
    setLoadingKey(group.key);
    setError(null);
    try {
      const { summaries, labels } = await loadSessionSummaries(group);
      onSelect(summaries, labels, group.key);
      setExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load that session.");
    } finally {
      setLoadingKey(null);
    }
  }

  const triggerLabel = selectedGroup
    ? `${sessionTimeLabel(selectedGroup.modifiedAt)} · ${sessionProtocolSummary(selectedGroup)}`
    : "Past sessions";

  return (
    <div className="session-history">
      <button
        type="button"
        className={`session-history-trigger${selectedKey ? " has-selection" : ""}`}
        onClick={() => void toggle()}
        aria-expanded={expanded}
        aria-haspopup="listbox"
      >
        <span className={`session-history-chevron ${expanded ? "open" : ""}`} aria-hidden="true">
          ▾
        </span>
        <span className="session-history-trigger-label">{triggerLabel}</span>
        {loaded && <span className="session-history-count">{sessions.length}</span>}
      </button>

      {expanded && (
        <div className="session-history-panel" role="listbox">
          {loading && <p className="hint">Loading session history…</p>}
          {error && <p className="error">{error}</p>}
          {!loading && loaded && sessions.length === 0 && (
            <p className="muted">No saved sessions yet — run a comparison to create one.</p>
          )}
          {!loading && sessions.length > 0 && (
            <ul className="session-history-list">
              {sessions.map((group) => {
                const selected = group.key === selectedKey;
                return (
                  <li key={group.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`session-history-item${selected ? " selected" : ""}`}
                      disabled={loadingKey === group.key}
                      onClick={() => void selectSession(group)}
                    >
                      <span className="session-history-item-time">
                        {sessionTimeLabel(group.modifiedAt)}
                      </span>
                      <span className="session-history-item-protocols">
                        {sessionProtocolSummary(group)}
                      </span>
                      {selected && <span className="session-history-item-badge">Selected</span>}
                      {loadingKey === group.key && <span className="hint">Loading…</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
