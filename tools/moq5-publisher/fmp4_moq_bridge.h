#ifndef FMP4_MOQ_BRIDGE_H
#define FMP4_MOQ_BRIDGE_H

/*
 * Incremental fMP4 (CMAF) → libmoq media-sender bridge.
 *
 * Intended callers: moq5-fmp4-publish (stdin), moq_link_spike, and later an
 * ffmpeg AVOutputFormat. Input is CMAF objects (moof+mdat), not annex-B.
 * Each moof+mdat pair must belong to one track (+separate_moof).
 *
 * Typical use:
 *   fmp4_moq_bridge_t *b = fmp4_moq_connect(url, namespace_, &opts);
 *   while (have_bytes)
 *       fmp4_moq_feed(b, bytes, len);
 *   fmp4_moq_close(b);
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct fmp4_moq_bridge fmp4_moq_bridge_t;

typedef struct fmp4_moq_opts {
    int insecure_skip_verify;
    int duration_sec;     /* 0 = unlimited */
    const char *qlog_dir; /* nullable */
} fmp4_moq_opts_t;

/* Connect to a MoQ relay and attach a live CMAF media sender.
 * opts may be NULL (all zeros). Returns NULL on failure. */
fmp4_moq_bridge_t *fmp4_moq_connect(const char *url, const char *namespace_,
                                    const fmp4_moq_opts_t *opts);

/* Feed arbitrary fMP4 bytes (may be partial boxes). Returns 0 on success
 * (including cooperative stop / duration expiry) and <0 on error. */
int fmp4_moq_feed(fmp4_moq_bridge_t *b, const uint8_t *data, size_t len);

/* Destroy sender, drain, stop the endpoint, and free the bridge.
 * Returns 0 on a clean finish, <0 if the stream was truncated. */
int fmp4_moq_close(fmp4_moq_bridge_t *b);

/* Cooperative stop for SIGINT. feed() returns 0; close() stays clean. */
void fmp4_moq_request_stop(void);

/* True after request_stop() or when duration_sec has elapsed. */
int fmp4_moq_should_stop(const fmp4_moq_bridge_t *b);

#ifdef __cplusplus
}
#endif

#endif /* FMP4_MOQ_BRIDGE_H */
