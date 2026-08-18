/**
 * MOQT drafts this browser publisher can speak.
 *
 * Newest IETF draft is draft-ietf-moq-transport-19 (July 2026). Neither
 * OpenMOQ moq5 (libmoq) nor @moqt/playa implement 19 yet — both top out at
 * draft-18. Current prod moqx only forwards draft-16. Offering `moqt-18`
 * can still make WebTransport ready, then SUBSCRIBE never reaches the
 * publisher (jobs d32a5e99 / 0840ceff / 2765cdee). This source stays on 16.
 */
export const NEWEST_MOQT_DRAFT = 16;
export const MOQT_DRAFTS_RELAY_FIRST = [16] as const;
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
