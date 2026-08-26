/**
 * Upload-only vs end-to-end test scope. Shown after Recipe for Build your
 * own; precanned recipes lock it (contribution stays upload-only;
 * source is webcam or cloud VOD).
 */

export const TEST_SCOPE_E2E = "e2e";
export const TEST_SCOPE_UPLOAD = "upload";

export type TestScope = typeof TEST_SCOPE_E2E | typeof TEST_SCOPE_UPLOAD;

export const DEFAULT_TEST_SCOPE: TestScope = TEST_SCOPE_E2E;

export const TEST_SCOPE_E2E_COPY = "Capture to glass — encode, ingest, and players.";
export const TEST_SCOPE_UPLOAD_COPY =
  "Encode, publish, and ingest. One confidence monitor. No glass.";

export const E2E_SCOPE_CAPTURE_TO_INGEST = "capture_to_ingest";

export function parseTestScope(value: unknown): TestScope {
  return value === TEST_SCOPE_UPLOAD ? TEST_SCOPE_UPLOAD : TEST_SCOPE_E2E;
}

export function isUploadOnlyScope(value: unknown): boolean {
  return parseTestScope(value) === TEST_SCOPE_UPLOAD;
}

export function testScopeBanner(value: unknown): string {
  return isUploadOnlyScope(value)
    ? "Ingest latency — not glass."
    : "End-to-end (capture to glass).";
}

export function testScopesCompatible(left: unknown, right: unknown): boolean {
  return parseTestScope(left) === parseTestScope(right);
}

export function resultTestScope(result: {
  summary_extra?: { test_scope?: string };
  rows?: Array<Record<string, string>>;
}): TestScope {
  return parseTestScope(
    result.summary_extra?.test_scope || result.rows?.[0]?.test_scope,
  );
}

/** Refuse to overlay two result sets that measured different things. */
export function canOverlayTestScopes(scopes: unknown[]): boolean {
  const normalized = scopes.map(parseTestScope);
  return normalized.every((scope) => scope === normalized[0]);
}
