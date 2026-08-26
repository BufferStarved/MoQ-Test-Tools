#ifndef FMP4_MOQ_BRIDGE_PRIV_H
#define FMP4_MOQ_BRIDGE_PRIV_H

/* Internal types and helpers shared with tools/moq5-publisher/test_multitrack.c.
 * Applications should include fmp4_moq_bridge.h only. */

#include "fmp4_moq_bridge.h"

#include <moq/cmaf.h>
#include <moq/media_sender.h>
#include <moq/types.h>

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

#ifdef __cplusplus
extern "C" {
#endif

enum { MAX_TRACKS = 4, ENDPOINT_DRAIN_TIMEOUT_US = 5000000 };

#define MP4_TYPE(a, b, c, d) \
    (((uint32_t)(a) << 24) | ((uint32_t)(b) << 16) | \
     ((uint32_t)(c) << 8) | (uint32_t)(d))

typedef struct {
    uint8_t *data;
    size_t len;
    size_t cap;
} byte_buf_t;

typedef struct {
    size_t offset;
    size_t size;
    size_t header_size;
    uint32_t type;
} mp4_box_t;

typedef struct {
    uint8_t bytes[16];
    size_t header_size;
    size_t body_size;
    char type[5];
} stream_box_header_t;

typedef struct {
    uint32_t track_id;
    char name[32];
    char codec[64];
    char channel_config[16];
    moq_media_type_t media_type;
    uint32_t timescale;
    uint32_t width;
    uint32_t height;
    uint32_t samplerate;
    uint32_t channel_count;
    byte_buf_t init;
    moq_media_track_t *handle;
    bool added;
} track_slot_t;

typedef struct {
    byte_buf_t init;
    track_slot_t tracks[MAX_TRACKS];
    size_t track_count;
    bool init_ready;
    bool sender_ready;
} app_ctx_t;

int buf_reserve(byte_buf_t *b, size_t need);
int buf_append(byte_buf_t *b, const uint8_t *src, size_t len);
void buf_free(byte_buf_t *b);

uint32_t read_be32(const uint8_t *p);
void write_be32(uint8_t *p, uint32_t value);

int mp4_box_at(const uint8_t *data, size_t len, size_t offset, mp4_box_t *out);
int read_box_header(int fd, stream_box_header_t *out);
int read_box_body(int fd, size_t body_len, byte_buf_t *out);

track_slot_t *track_for_id(app_ctx_t *ctx, uint32_t track_id);
int init_track_count(const byte_buf_t *init, size_t *out_count);
int discover_tracks(app_ctx_t *ctx);
void clear_discovered_tracks(app_ctx_t *ctx);
void fill_track_cfg(const track_slot_t *slot, moq_media_track_cfg_t *tc);
void init_sender_cfg(moq_media_sender_cfg_t *cfg, moq_bytes_t *namespace_parts,
                     size_t namespace_count);

#ifdef __cplusplus
}
#endif

#endif /* FMP4_MOQ_BRIDGE_PRIV_H */
