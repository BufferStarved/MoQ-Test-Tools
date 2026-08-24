/**
 * Results empty-state helpers, overlay clock, and jitter probe sanitizer.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resultFilenameFromPath(csvPath) {
  if (!csvPath) return null;
  const parts = csvPath.replace(/\\/g, "/").split("/");
  const name = parts[parts.length - 1] || "";
  if (name.endsWith(".csv")) return name;
  if (/^upload_[\w-]+$/i.test(name)) return `${name}.csv`;
  return null;
}

assert.equal(resultFilenameFromPath("/tmp/results/upload_20260818_ab12cd.csv"), "upload_20260818_ab12cd.csv");
assert.equal(resultFilenameFromPath("C:\\\\results\\\\upload_x.csv"), "upload_x.csv");
assert.equal(resultFilenameFromPath("/Users/sean/results/upload_abc"), "upload_abc.csv");
assert.equal(resultFilenameFromPath(""), null);
assert.equal(resultFilenameFromPath(null), null);

function dropProbeJitterSpike(points) {
  if (points.length < 3) return points;
  const first = points[0]?.net_jitter_ms ?? 0;
  const rest = points.slice(1, 6).map((point) => point.net_jitter_ms ?? 0);
  const sorted = [...rest].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (first >= 40 && first > Math.max(8, median * 5)) {
    return [{ ...points[0], net_jitter_ms: rest[0] ?? median }, ...points.slice(1)];
  }
  return points;
}

const spiked = dropProbeJitterSpike([
  { second: 0, net_jitter_ms: 140 },
  { second: 1, net_jitter_ms: 2 },
  { second: 2, net_jitter_ms: 1 },
  { second: 3, net_jitter_ms: 2 },
]);
assert.ok(spiked[0].net_jitter_ms < 10, "first jitter spike must not chart as 140ms");

const apiSrc = fs.readFileSync(path.join(root, "src/api.ts"), "utf8");
assert.match(apiSrc, /resultFilenameFromPath/);
const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
assert.match(appSrc, /loadSessionMetricsFromLegs/);
assert.match(appSrc, /Do not wait for VMAF/);
const sessionSrc = fs.readFileSync(path.join(root, "src/SessionMetrics.tsx"), "utf8");
assert.match(sessionSrc, /No charts for this page yet/);
const previewSrc = fs.readFileSync(path.join(root, "src/WebcamLivePreview.tsx"), "utf8");
assert.match(previewSrc, /wall-clock/);
assert.match(previewSrc, /webcam-preview-clock/);
assert.doesNotMatch(previewSrc, /className="webcam-live-preview-video".*scaleX/);
const cssSrc = fs.readFileSync(path.join(root, "src/App.css"), "utf8");
assert.match(cssSrc, /webcam-preview-clock/);
assert.doesNotMatch(cssSrc, /\.webcam-live-preview-video \{[\s\S]*transform: scaleX\(-1\)/);
const sourceSrc = fs.readFileSync(path.join(root, "src/SourceSection.tsx"), "utf8");
assert.match(sourceSrc, /sourceModeExplainer/);
assert.match(sourceSrc, /Laptop → cloud ingest/);
assert.match(sourceSrc, /Cloud → cloud ingest/);
assert.match(sourceSrc, /This laptop cannot publish WebRTC yet/);
assert.doesNotMatch(sourceSrc, /run-local-publisher/);
const playbackSrc = fs.readFileSync(path.join(root, "src/playbackUrls.ts"), "utf8");
assert.match(playbackSrc, /mediaMtxMpegTsRemuxUrl/);
assert.match(playbackSrc, /advancedUrlRows/);
assert.match(playbackSrc, /MPEG-TS \(remux from HLS\)/);
assert.match(playbackSrc, /Play \(\$\{playEngineLabel/);
const chartsSrc = fs.readFileSync(path.join(root, "src/ComparisonCharts.tsx"), "utf8");
assert.match(chartsSrc, /hidden instead of plotting a flat zero/);
assert.match(chartsSrc, /muxer\s+warms up/);
assert.match(chartsSrc, /How many bits the encoder is producing/);
const metricChartSrc = fs.readFileSync(path.join(root, "src/MetricChart.tsx"), "utf8");
assert.match(metricChartSrc, /: nonzeroSeries;/);
assert.doesNotMatch(metricChartSrc, /nonzeroSeries.length > 0/);
const aboutSrc = fs.readFileSync(path.join(root, "src/AboutPage.tsx"), "utf8");
assert.match(aboutSrc, /encode time 00:01:23/);
assert.doesNotMatch(aboutSrc, /ENC T\+/);

console.log("unit-results-clock-charts: PASS");
