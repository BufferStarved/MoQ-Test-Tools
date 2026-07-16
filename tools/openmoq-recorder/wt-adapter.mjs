/**
 * Adapt Node @fails-components/webtransport session to @moqt/webtransport WebTransportLike.
 * Duplicated from moq-playa examples (kept local to avoid coupling to example packages).
 */

/** @param {import('@moqt/webtransport').WebTransportLike} session */
export function nodeSessionToWebTransportLike(session) {
  return {
    ...(session.protocol !== undefined ? { protocol: session.protocol } : {}),
    get incomingUnidirectionalStreams() {
      return session.incomingUnidirectionalStreams;
    },
    get incomingBidirectionalStreams() {
      return session.incomingBidirectionalStreams;
    },
    get datagrams() {
      return session.datagrams;
    },
    get closed() {
      return session.closed;
    },
    createBidirectionalStream: () => session.createBidirectionalStream(),
    createUnidirectionalStream: () => session.createUnidirectionalStream(),
    close: (info) => session.close(info),
  };
}
