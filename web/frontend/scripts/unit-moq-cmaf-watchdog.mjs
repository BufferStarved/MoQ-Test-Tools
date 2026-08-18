/**
 * CMAF stall watchdog: only resubscribe when the playhead is frozen AND
 * the MSE buffer is starved. A freeze with media queued is an MSE hole,
 * not a dead session.
 * Mirrors web/frontend/src/players/MoqPlayer.tsx.
 */
import assert from "node:assert/strict";

function shouldRestartCmafSession({ frozenMs, stallLimitMs, bufferedAheadSec, minStarveSec = 0.35 }) {
  if (frozenMs < stallLimitMs) return false;
  return bufferedAheadSec < minStarveSec;
}

function moqEndedPlayerStatus({ playedOk, sessionRestarts }) {
  if (!playedOk) return null;
  if (sessionRestarts > 0) {
    return `Playback ended (reconnected ${sessionRestarts}× after a freeze)`;
  }
  return "Playback OK";
}

assert.equal(
  shouldRestartCmafSession({ frozenMs: 1750, stallLimitMs: 1750, bufferedAheadSec: 1.2 }),
  false,
);
assert.equal(
  shouldRestartCmafSession({ frozenMs: 1750, stallLimitMs: 1750, bufferedAheadSec: 0.1 }),
  true,
);
assert.equal(
  shouldRestartCmafSession({ frozenMs: 500, stallLimitMs: 1750, bufferedAheadSec: 0 }),
  false,
);

assert.equal(moqEndedPlayerStatus({ playedOk: true, sessionRestarts: 0 }), "Playback OK");
assert.equal(
  moqEndedPlayerStatus({ playedOk: true, sessionRestarts: 1 }),
  "Playback ended (reconnected 1× after a freeze)",
);
assert.equal(moqEndedPlayerStatus({ playedOk: false, sessionRestarts: 0 }), null);

console.log("unit-moq-cmaf-watchdog: PASS");
