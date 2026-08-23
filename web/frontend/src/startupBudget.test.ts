import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLAYER_PHASE_NOTES,
  PROTOCOL_PHASE_NOTES,
  STAGE_NAMES,
  STARTUP_COLUMNS,
  STARTUP_COMPONENTS,
  STARTUP_PLAYER_COMPONENTS,
  STARTUP_PUBLISHER_COMPONENTS,
  buildPlayerStartup,
  buildPublisherStartup,
  buildStartupBudget,
  cleanPhaseMs,
  notApplicableColumns,
  playerNotApplicableColumns,
  startupBudgetFromColumns,
  startupBudgetShares,
} from "./startupBudget.ts";

const RTMP_MILESTONES = {
  protocol: "rtmp",
  t0: 100.0,
  dnsDone: 100.01,
  connectDone: 100.035,
  handshakeDone: 100.09,
  publishAccepted: 100.4,
  firstIdr: 100.9,
  firstByteIngest: 101.0,
};

test("a phase is the gap it owns, not its offset from job start", () => {
  const half = buildPublisherStartup(RTMP_MILESTONES);
  assert.equal(half.phases.startup_dns_ms, 10);
  assert.equal(half.phases.startup_connect_ms, 25);
  assert.equal(half.phases.startup_handshake_ms, 55);
  assert.equal(half.phases.startup_publish_accept_ms, 310);
  assert.equal(half.phases.startup_first_idr_ms, 500);
  assert.equal(half.phases.startup_first_byte_ingest_ms, 100);
});

test("a fully measured publisher chain reconciles exactly", () => {
  const half = buildPublisherStartup(RTMP_MILESTONES);
  assert.equal(half.measuredMs, 1000);
  assert.equal(half.accountedMs, 1000);
  assert.equal(half.residualMs, 0);
  assert.equal(half.overcountMs, 0);
  assert.deepEqual(half.unmeasured, []);
});

test("a missing middle milestone unmeasures both neighbours", () => {
  // Reporting publish_accept as "connect_done → publish_accepted" would move
  // the whole handshake into it and read as a slow ingest accept, which is
  // exactly the misattribution this family exists to prevent.
  const half = buildPublisherStartup({ ...RTMP_MILESTONES, handshakeDone: null });
  assert.equal(half.phases.startup_handshake_ms, null);
  assert.equal(half.phases.startup_publish_accept_ms, null);
  assert.equal(half.accountedMs, 10 + 25 + 500 + 100);
  assert.equal(half.residualMs, 365);
  assert.equal(half.overcountMs, 0);
});

test("a measured zero is not the same as an unmeasured phase", () => {
  // A warm DNS cache really does resolve inside the measurement resolution.
  const measured = buildPublisherStartup({ protocol: "rtmp", t0: 100, dnsDone: 100 });
  assert.equal(measured.phases.startup_dns_ms, 0);
  assert.ok(!measured.unmeasured.includes("startup_dns_ms"));

  const unmeasured = buildPublisherStartup({ protocol: "rtmp", t0: 100 });
  assert.equal(unmeasured.phases.startup_dns_ms, null);
  assert.ok(unmeasured.unmeasured.includes("startup_dns_ms"));
});

test("SRT connect is not-applicable and the handshake spans it", () => {
  // Marking connect unmeasured would send an operator looking for a TCP
  // connect that never happens over UDP.
  const half = buildPublisherStartup({
    protocol: "srt",
    t0: 100.0,
    dnsDone: 100.01,
    handshakeDone: 100.21,
    publishAccepted: 100.4,
    firstIdr: 100.9,
    firstByteIngest: 101.0,
  });
  assert.ok(half.notApplicable.includes("startup_connect_ms"));
  assert.ok(!half.unmeasured.includes("startup_connect_ms"));
  assert.equal(half.phases.startup_handshake_ms, 200);
  assert.equal(half.accountedMs, 1000);
  assert.equal(half.residualMs, 0);
});

test("residual and overcount are signed opposites, never both set", () => {
  const over = buildPublisherStartup({ ...RTMP_MILESTONES, firstByteIngest: 100.5 });
  assert.ok(over.overcountMs > 0 || over.residualMs > 0);
  assert.equal(Math.min(over.overcountMs, over.residualMs), 0);
});

test("an implausible phase is dropped, not clamped to the ceiling", () => {
  // A clamped artifact charts exactly like a real two-minute phase.
  assert.equal(cleanPhaseMs(600_000), null);
  assert.equal(cleanPhaseMs(-5), null);
  assert.equal(cleanPhaseMs(Number.NaN), null);
  assert.equal(cleanPhaseMs(null), null);
  assert.equal(cleanPhaseMs(""), null);
  assert.equal(cleanPhaseMs(0), 0);
  assert.equal(cleanPhaseMs("0.0"), 0);
});

test("the 23s RTMP startup this family explains survives the ceiling", () => {
  const half = buildPublisherStartup({
    protocol: "rtmp",
    t0: 0,
    dnsDone: 0.01,
    connectDone: 0.03,
    handshakeDone: 0.06,
    publishAccepted: 23.0,
    firstIdr: 23.1,
    firstByteIngest: 23.2,
  });
  // The GOP pinned to the HLS chunk duration shows up as one fat phase, which
  // is the whole point: 23s → 1501 ms was found by reasoning about this.
  assert.equal(half.phases.startup_publish_accept_ms, 22_940);
  assert.equal(half.measuredMs, 23_200);
});

test("the player chain reconciles against measured TTFF", () => {
  const half = buildPlayerStartup({
    engine: "hls",
    requestMs: 30,
    manifestMs: 120,
    firstMediaMs: 800,
    firstPaintMs: 551,
    ttffMs: 1501,
  });
  assert.equal(half.accountedMs, 1501);
  assert.equal(half.measuredMs, 1501);
  assert.equal(half.residualMs, 0);
  assert.equal(half.overcountMs, 0);
});

test("a player residual names the phases that have no instrument", () => {
  const half = buildPlayerStartup({ engine: "hls", requestMs: 30, manifestMs: 120, ttffMs: 1501 });
  assert.equal(half.accountedMs, 150);
  assert.equal(half.residualMs, 1351);
  assert.deepEqual(half.unmeasured, ["startup_first_media_ms", "startup_first_paint_ms"]);
});

test("a raw MPEG-TS pull has no manifest phase at all", () => {
  // 0 ms would imply an instant fetch of something that does not exist.
  const half = buildPlayerStartup({ engine: "mpegts", requestMs: 20, ttffMs: 900 });
  assert.ok(half.notApplicable.includes("startup_manifest_ms"));
  assert.ok(!half.unmeasured.includes("startup_manifest_ms"));
  assert.deepEqual(buildPlayerStartup({ engine: "hls", ttffMs: 900 }).notApplicable, []);
});

test("the two chains stay separate spans", () => {
  // 40s of operator dwell between ingest and player attach must not become
  // startup: a joined total would be dominated by human reaction time.
  const budget = buildStartupBudget(
    { ...RTMP_MILESTONES },
    { engine: "hls", requestMs: 30, manifestMs: 120, ttffMs: 1501 },
  );
  assert.equal(budget.publisher.measuredMs, 1000);
  assert.equal(budget.player.measuredMs, 1501);
  assert.ok(!("startup_total_ms" in budget));
});

test("columns rebuilt from a CSV row keep blank distinct from zero", () => {
  const budget = startupBudgetFromColumns(
    {
      startup_dns_ms: "0.0",
      startup_connect_ms: "",
      startup_handshake_ms: "55.0",
      startup_publisher_measured_ms: "1000.0",
      startup_not_applicable: "",
    },
    { protocol: "rtmp", engine: "hls" },
  );
  assert.equal(budget.publisher.phases.startup_dns_ms, 0);
  assert.ok(!budget.publisher.unmeasured.includes("startup_dns_ms"));
  assert.ok(budget.publisher.unmeasured.includes("startup_connect_ms"));
  // An empty annotation is a positive statement, not a missing one.
  assert.deepEqual(budget.publisher.notApplicable, []);
});

test("a reported not-applicable annotation wins over the protocol table", () => {
  const budget = startupBudgetFromColumns(
    { startup_not_applicable: "connect,manifest", startup_publisher_measured_ms: "500" },
    { protocol: "rtmp", engine: "hls" },
  );
  assert.deepEqual(budget.publisher.notApplicable, ["startup_connect_ms"]);
  assert.deepEqual(budget.player.notApplicable, ["startup_manifest_ms"]);
  assert.ok(!budget.publisher.unmeasured.includes("startup_connect_ms"));
});

test("a missing annotation falls back to the protocol and engine tables", () => {
  const budget = startupBudgetFromColumns({ startup_publisher_measured_ms: "500" }, {
    protocol: "srt",
    engine: "mpegts",
  });
  assert.deepEqual(budget.publisher.notApplicable, ["startup_connect_ms"]);
  assert.deepEqual(budget.player.notApplicable, ["startup_manifest_ms"]);
});

test("shares cover the whole measured total and name the trailing segment", () => {
  const half = buildPlayerStartup({ engine: "hls", requestMs: 30, manifestMs: 120, ttffMs: 1501 });
  const shares = startupBudgetShares(half);
  if (!shares) {
    throw new Error("expected shares for a measured total");
  }
  const total = shares.reduce((sum, part) => sum + part.pct, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `shares summed to ${total}`);
  assert.equal(shares[shares.length - 1].key, "residual");
  // Unmeasured phases still appear, flagged, so the view can draw them as a
  // different fact from a measured 0 rather than dropping them.
  const firstMedia = shares.find((part) => part.key === "startup_first_media_ms");
  assert.ok(firstMedia?.unmeasured);
  assert.equal(firstMedia?.ms, 0);
});

test("shares surface over-attribution instead of a clamped residual", () => {
  const half = buildPlayerStartup({
    engine: "hls",
    requestMs: 500,
    manifestMs: 500,
    firstMediaMs: 500,
    firstPaintMs: 500,
    ttffMs: 900,
  });
  const shares = startupBudgetShares(half);
  if (!shares) {
    throw new Error("expected shares for a measured total");
  }
  assert.ok(shares.some((part) => part.key === "overcount"));
  assert.ok(!shares.some((part) => part.key === "residual"));
});

test("no measured total means there is nothing to stack against", () => {
  const half = buildPlayerStartup({ engine: "hls", requestMs: 30 });
  assert.equal(startupBudgetShares(half), null);
});

test("the not-applicable table agrees with the blank protocol notes", () => {
  // Two tables that disagree would put a phase in both "no instrument" and
  // "cannot exist". The Python asserts the same property.
  for (const protocol of ["rtmp", "srt", "webrtc", "moq"]) {
    const absent = new Set(notApplicableColumns(protocol));
    for (const column of STARTUP_PUBLISHER_COMPONENTS) {
      const stage = STAGE_NAMES[STARTUP_COMPONENTS.indexOf(column)];
      const blank = PROTOCOL_PHASE_NOTES[protocol][stage] === "";
      assert.equal(blank, absent.has(column), `${protocol}/${stage}`);
    }
  }
});

test("every engine documents every player phase", () => {
  for (const engine of ["hls", "ll-hls", "mpegts", "whep", "moq", "dash"]) {
    for (const stage of ["player_request", "manifest", "first_media", "first_paint"]) {
      assert.ok(stage in PLAYER_PHASE_NOTES[engine], `${engine}/${stage}`);
    }
  }
  assert.deepEqual(playerNotApplicableColumns("mpegts"), ["startup_manifest_ms"]);
  // An unknown engine yields nothing: we do not know what it lacks.
  assert.deepEqual(playerNotApplicableColumns("unknown-engine"), []);
});

test("the column set matches the schema contract", () => {
  assert.equal(STARTUP_COMPONENTS.length, 10);
  assert.equal(STARTUP_COLUMNS.length, 20);
  assert.equal(STAGE_NAMES.length, STARTUP_COMPONENTS.length);
  assert.equal(
    STARTUP_COMPONENTS.length,
    STARTUP_PUBLISHER_COMPONENTS.length + STARTUP_PLAYER_COMPONENTS.length,
  );
});
