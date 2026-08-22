/**
 * MOQT drafts this browser publisher can speak.
 *
 * Branch `feat/moq-draft-18`: offer and lock `moqt-18`.
 * Public site MoQ is :14433 / moqt-18. Leftover :4433 stays draft-16 and
 * is hidden. Do not merge this branch to `main`.
 *
 * IETF newest is draft-ietf-moq-transport-19 (July 2026). Neither
 * OpenMOQ moq5 nor @moqt/playa implement 19 yet — both top out at 18.
 */
export const NEWEST_MOQT_DRAFT = 18;
export const MOQT_DRAFTS_RELAY_FIRST = [18] as const;
export const MOQT_DRAFTS_NEWEST_FIRST = MOQT_DRAFTS_RELAY_FIRST;
export type MoqtDraftVersion = 16 | 18;

export function moqtProtocolToken(draft: MoqtDraftVersion): string {
  return `moqt-${draft}`;
}

export function draftFromProtocol(protocol: string | undefined): MoqtDraftVersion | undefined {
  if (protocol === "moqt-18") {
    return 18;
  }
  if (protocol === "moqt-16") {
    return 16;
  }
  return undefined;
}

export function moqtDraftLabel(draft: MoqtDraftVersion): string {
  return `MOQT draft-${draft}`;
}
