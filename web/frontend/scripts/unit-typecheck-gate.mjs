/**
 * Typecheck-gate wiring. `vite build` does not typecheck, so a dropped import
 * (proxiedWebrtcSignalingUrl) once shipped to prod as a ReferenceError. The
 * gate that catches it is `npm run typecheck` in scripts/run-regression.sh.
 *
 * This asserts the wiring only — it does not re-run tsc, because
 * run-regression.sh already runs it and a second full compile costs seconds
 * for no extra coverage. Replaces the old TS2304-only filter, which passed
 * while 105 other type errors accumulated.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(frontend, "../..");

const pkg = JSON.parse(fs.readFileSync(path.join(frontend, "package.json"), "utf8"));
assert.equal(
  pkg.scripts?.typecheck,
  "tsc --noEmit",
  "web/frontend/package.json must keep a `typecheck` script running `tsc --noEmit`",
);

const regression = fs.readFileSync(path.join(repoRoot, "scripts/run-regression.sh"), "utf8");
assert.match(
  regression,
  /npm run --silent typecheck/,
  "scripts/run-regression.sh must invoke `npm run --silent typecheck`",
);

// Strictness the 105-error cleanup depended on. Turning any of these off would
// let the gate pass while real nullability / dead-code regressions land.
const tsconfig = fs.readFileSync(path.join(frontend, "tsconfig.json"), "utf8");
for (const flag of ["strict", "noUnusedLocals", "noUnusedParameters"]) {
  assert.match(
    tsconfig,
    new RegExp(`"${flag}"\\s*:\\s*true`),
    `web/frontend/tsconfig.json must keep "${flag}": true`,
  );
}

// Blanket suppressions would silently re-open the hole this gate closes.
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const offenders = sourceFiles(path.join(frontend, "src"))
  .filter((file) => {
    const body = fs.readFileSync(file, "utf8");
    return body.includes("@ts-nocheck") || body.includes("@ts-ignore");
  })
  .map((file) => path.relative(frontend, file));
assert.deepEqual(
  offenders,
  [],
  `@ts-nocheck / @ts-ignore defeat the typecheck gate — use @ts-expect-error with a reason: ${offenders.join(", ")}`,
);

console.log("unit-typecheck-gate: PASS");
