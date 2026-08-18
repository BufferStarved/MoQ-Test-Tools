/**
 * Missing-identifier gate. `vite build` does not typecheck, so a dropped
 * import (proxiedWebrtcSignalingUrl) shipped to prod as a ReferenceError.
 * Fail the regression on tsc TS2304 only — other legacy tsc noise stays.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  "npx",
  ["tsc", "--noEmit", "--pretty", "false"],
  { cwd: frontend, encoding: "utf8" },
);
const out = `${result.stdout || ""}${result.stderr || ""}`;
const missing = out
  .split("\n")
  .filter((line) => line.includes("error TS2304: Cannot find name"));

if (missing.length > 0) {
  console.error("unit-tsc-cannot-find-name: FAIL");
  for (const line of missing) {
    console.error(line);
  }
  process.exit(1);
}

console.log("unit-tsc-cannot-find-name: PASS");
