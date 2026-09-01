/*
 * Incremental fMP4 (CMAF) → libmoq media-sender bridge.
 *
 * separate_moof is required: each moof+mdat pair must belong to one track.
 * The init segment may contain several traks; each is advertised separately.
 */

#include "fmp4_moq_bridge_priv.h"

#include <moq/endpoint.h>
#include <moq/rcbuf.h>

#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t g_stop = 0;

enum {
    BOX_PHASE_HEADER = 0,
    BOX_PHASE_KEEP = 1,
    BOX_PHASE_SKIP = 2
};

typedef struct {
    uint8_t hdr[16];
    size_t hdr_got;
    size_t header_size;
    size_t body_size;
    size_t body_got;
    char type[5];
    int phase;
    byte_buf_t *dest;
} box_parser_t;

struct fmp4_moq_bridge {
    moq_endpoint_t *ep;
    moq_media_sender_t *tx;
    app_ctx_t ctx;
    box_parser_t parser;
    byte_buf_t pending_moof;
    byte_buf_t pending_mdat;
    bool have_moof;
    char urlbuf[1024];
    char nsbuf[256];
    moq_bytes_t ns_parts[32];
    size_t ns_count;
    int insecure_skip_verify;
    int duration_sec;
    time_t deadline;
    int session_live;
    pthread_t connect_th;
    int connect_started;
    int connect_done;
    moq_result_t connect_rc;
    pthread_mutex_t connect_mu;
    pthread_cond_t connect_cv;
};

int buf_reserve(byte_buf_t *b, size_t need)
{
    if (need <= b->cap) {
        return 0;
    }
    size_t new_cap = b->cap ? b->cap : 4096;
    while (new_cap < need) {
        if (new_cap > SIZE_MAX / 2) {
            new_cap = need;
            break;
        }
        new_cap *= 2;
    }
    uint8_t *next = realloc(b->data, new_cap);
    if (!next) {
        return -1;
    }
    b->data = next;
    b->cap = new_cap;
    return 0;
}

int buf_append(byte_buf_t *b, const uint8_t *src, size_t len)
{
    if (len > SIZE_MAX - b->len || (len > 0 && src == NULL)) {
        return -1;
    }
    if (buf_reserve(b, b->len + len) != 0) {
        return -1;
    }
    memcpy(b->data + b->len, src, len);
    b->len += len;
    return 0;
}

void buf_free(byte_buf_t *b)
{
    free(b->data);
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

uint32_t read_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static uint64_t read_be64(const uint8_t *p)
{
    return ((uint64_t)read_be32(p) << 32) | read_be32(p + 4);
}

void write_be32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value >> 24);
    p[1] = (uint8_t)(value >> 16);
    p[2] = (uint8_t)(value >> 8);
    p[3] = (uint8_t)value;
}

int mp4_box_at(const uint8_t *data, size_t len, size_t offset, mp4_box_t *out)
{
    if (!data || !out || offset > len || len - offset < 8) {
        return -1;
    }

    uint32_t size32 = read_be32(data + offset);
    size_t header_size = 8;
    uint64_t box_size = size32;
    if (size32 == 1) {
        if (len - offset < 16) {
            return -1;
        }
        header_size = 16;
        box_size = read_be64(data + offset + 8);
    } else if (size32 == 0) {
        box_size = len - offset;
    }
    if (box_size < header_size || box_size > len - offset ||
        box_size > SIZE_MAX) {
        return -1;
    }

    out->offset = offset;
    out->size = (size_t)box_size;
    out->header_size = header_size;
    out->type = read_be32(data + offset + 4);
    return 0;
}

/* ffmpeg +frag_keyframe puts the IDR in trun first-sample-flags (0x000004)
 * and marks default_sample_flags non-sync. libmoq parse_trun used to skip
 * that field, so vide_1 looked like a delta and media_sender returned
 * WOULD_BLOCK ("group cannot lead with a delta") for every GOP. */
static uint32_t cmaf_first_sample_flags(const uint8_t *data, size_t len,
                                        uint32_t fallback)
{
    size_t stack[16];
    size_t stack_end[16];
    size_t depth = 0;
    stack[0] = 0;
    stack_end[0] = len;
    depth = 1;
    while (depth > 0) {
        size_t *off = &stack[depth - 1];
        size_t end = stack_end[depth - 1];
        if (*off + 8 > end) {
            depth--;
            continue;
        }
        mp4_box_t box;
        if (mp4_box_at(data, end, *off, &box) != 0) {
            break;
        }
        *off += box.size;
        if (box.type == MP4_TYPE('t', 'r', 'u', 'n')) {
            const uint8_t *p = data + box.offset + box.header_size;
            size_t r = box.size > box.header_size ? box.size - box.header_size : 0;
            if (r < 8) {
                return fallback;
            }
            uint32_t fl = ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
            p += 8;
            r -= 8;
            if ((fl & 0x01u) != 0) {
                if (r < 4) {
                    return fallback;
                }
                p += 4;
                r -= 4;
            }
            if ((fl & 0x04u) != 0) {
                if (r < 4) {
                    return fallback;
                }
                return read_be32(p);
            }
            if ((fl & 0x400u) != 0) {
                if ((fl & 0x100u) != 0) {
                    if (r < 4) {
                        return fallback;
                    }
                    p += 4;
                    r -= 4;
                }
                if ((fl & 0x200u) != 0) {
                    if (r < 4) {
                        return fallback;
                    }
                    p += 4;
                    r -= 4;
                }
                if (r < 4) {
                    return fallback;
                }
                return read_be32(p);
            }
            return fallback;
        }
        if ((box.type == MP4_TYPE('m', 'o', 'o', 'f') ||
             box.type == MP4_TYPE('t', 'r', 'a', 'f')) &&
            depth < 16) {
            stack[depth] = box.offset + box.header_size;
            stack_end[depth] = box.offset + box.size;
            depth++;
        }
    }
    return fallback;
}

static int read_exact(int fd, void *dst, size_t len)
{
    uint8_t *out = dst;
    size_t off = 0;
    while (off < len) {
        ssize_t n = read(fd, out + off, len - off);
        if (n == 0) {
            return -1;
        }
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        off += (size_t)n;
    }
    return 0;
}

/* Return 1 only for a clean EOF before the next box, 0 for a complete header,
 * and -1 for malformed/truncated input or an I/O error. */
int read_box_header(int fd, stream_box_header_t *out)
{
    if (!out) {
        return -1;
    }
    memset(out, 0, sizeof(*out));

    size_t off = 0;
    while (off < 8) {
        ssize_t n = read(fd, out->bytes + off, 8 - off);
        if (n == 0) {
            return off == 0 ? 1 : -1;
        }
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        off += (size_t)n;
    }

    uint32_t size32 = read_be32(out->bytes);
    memcpy(out->type, out->bytes + 4, 4);
    out->type[4] = '\0';

    if (size32 == 1) {
        if (read_exact(fd, out->bytes + 8, 8) != 0) {
            return -1;
        }
        uint64_t size64 = read_be64(out->bytes + 8);
        if (size64 < 16 || size64 - 16 > SIZE_MAX) {
            return -1;
        }
        out->header_size = 16;
        out->body_size = (size_t)(size64 - 16);
    } else if (size32 == 0) {
        /* A box extending to EOF cannot be followed by another streamed box,
         * so it is incompatible with this incremental moof+mdat reader. */
        return -1;
    } else if (size32 < 8) {
        return -1;
    } else {
        out->header_size = 8;
        out->body_size = size32 - 8u;
    }
    return 0;
}

int read_box_body(int fd, size_t body_len, byte_buf_t *out)
{
    if (!out || body_len > SIZE_MAX - out->len) {
        return -1;
    }
    if (body_len == 0) {
        return 0;
    }
    size_t old_len = out->len;
    if (buf_reserve(out, old_len + body_len) != 0) {
        return -1;
    }
    if (read_exact(fd, out->data + old_len, body_len) != 0) {
        return -1;
    }
    out->len = old_len + body_len;
    return 0;
}

static size_t split_namespace(char *buf, moq_bytes_t *parts, size_t max)
{
    size_t n = 0;
    char *p = buf;
    while (*p && n < max) {
        char *slash = strchr(p, '/');
        if (slash) {
            *slash = '\0';
        }
        parts[n].data = (const uint8_t *)p;
        parts[n].len = strlen(p);
        n++;
        if (!slash) {
            break;
        }
        p = slash + 1;
    }
    return n;
}

track_slot_t *track_for_id(app_ctx_t *ctx, uint32_t track_id)
{
    for (size_t i = 0; i < ctx->track_count; i++) {
        if (ctx->tracks[i].track_id == track_id) {
            return &ctx->tracks[i];
        }
    }
    return NULL;
}

int init_track_count(const byte_buf_t *init, size_t *out_count)
{
    if (!init || !out_count) {
        return -1;
    }
    *out_count = 0;

    size_t pos = 0;
    bool found_moov = false;
    while (pos < init->len) {
        mp4_box_t top;
        if (mp4_box_at(init->data, init->len, pos, &top) != 0) {
            return -1;
        }
        if (top.type == MP4_TYPE('m', 'o', 'o', 'v')) {
            if (found_moov) {
                return -1;
            }
            found_moov = true;
            size_t child_pos = top.offset + top.header_size;
            size_t child_end = top.offset + top.size;
            while (child_pos < child_end) {
                mp4_box_t child;
                if (mp4_box_at(init->data, child_end, child_pos, &child) != 0) {
                    return -1;
                }
                if (child.type == MP4_TYPE('t', 'r', 'a', 'k')) {
                    if (*out_count == SIZE_MAX) {
                        return -1;
                    }
                    (*out_count)++;
                }
                child_pos += child.size;
            }
        }
        pos += top.size;
    }
    return found_moov && *out_count > 0 ? 0 : -1;
}

static int trak_track_id(const uint8_t *data, size_t len, uint32_t *out_id)
{
    if (!data || !out_id) {
        return -1;
    }
    mp4_box_t trak;
    if (mp4_box_at(data, len, 0, &trak) != 0 || trak.size != len ||
        trak.type != MP4_TYPE('t', 'r', 'a', 'k')) {
        return -1;
    }

    size_t pos = trak.header_size;
    while (pos < trak.size) {
        mp4_box_t child;
        if (mp4_box_at(data, trak.size, pos, &child) != 0) {
            return -1;
        }
        if (child.type == MP4_TYPE('t', 'k', 'h', 'd')) {
            size_t body = child.offset + child.header_size;
            size_t body_len = child.size - child.header_size;
            if (body_len < 4) {
                return -1;
            }
            size_t id_offset;
            if (data[body] == 0) {
                id_offset = 12;
            } else if (data[body] == 1) {
                id_offset = 20;
            } else {
                return -1;
            }
            if (body_len < id_offset + 4) {
                return -1;
            }
            *out_id = read_be32(data + body + id_offset);
            return *out_id == 0 ? -1 : 0;
        }
        pos += child.size;
    }
    return -1;
}

/* Append mvex while retaining shared children and only the trex belonging to
 * the selected track. With out == NULL, only compute the resulting box size. */
static int filter_mvex(const uint8_t *data, size_t len, uint32_t track_id,
                       byte_buf_t *out, size_t *out_size)
{
    if (!data || !out_size || track_id == 0) {
        return -1;
    }
    mp4_box_t mvex;
    if (mp4_box_at(data, len, 0, &mvex) != 0 || mvex.size != len ||
        mvex.type != MP4_TYPE('m', 'v', 'e', 'x')) {
        return -1;
    }

    size_t kept_body_size = 0;
    size_t pos = mvex.header_size;
    size_t trex_count = 0;
    size_t matching_trex = 0;
    while (pos < mvex.size) {
        mp4_box_t child;
        if (mp4_box_at(data, mvex.size, pos, &child) != 0) {
            return -1;
        }
        bool keep = true;
        if (child.type == MP4_TYPE('t', 'r', 'e', 'x')) {
            size_t body_len = child.size - child.header_size;
            if (body_len < 8) {
                return -1;
            }
            trex_count++;
            keep = read_be32(data + child.offset + child.header_size + 4) ==
                   track_id;
            if (keep) {
                matching_trex++;
            }
        }
        if (keep) {
            if (child.size > SIZE_MAX - kept_body_size) {
                return -1;
            }
            kept_body_size += child.size;
        }
        pos += child.size;
    }
    if ((trex_count > 0 && matching_trex != 1) ||
        kept_body_size > UINT32_MAX - 8u) {
        return -1;
    }
    *out_size = kept_body_size + 8u;
    if (!out) {
        return 0;
    }

    uint8_t header[8];
    write_be32(header, (uint32_t)*out_size);
    write_be32(header + 4, MP4_TYPE('m', 'v', 'e', 'x'));
    if (buf_append(out, header, sizeof(header)) != 0) {
        return -1;
    }

    pos = mvex.header_size;
    while (pos < mvex.size) {
        mp4_box_t child;
        if (mp4_box_at(data, mvex.size, pos, &child) != 0) {
            return -1;
        }
        bool keep = child.type != MP4_TYPE('t', 'r', 'e', 'x') ||
                    read_be32(data + child.offset + child.header_size + 4) ==
                        track_id;
        if (keep &&
            buf_append(out, data + child.offset, child.size) != 0) {
            return -1;
        }
        pos += child.size;
    }
    return 0;
}

/* Build a per-track CMAF initialization segment. The input moov may contain
 * several trak boxes; MSF catalog entries and libmoq's track validation need
 * the init associated with one media track. Keep shared moov children, the
 * selected trak, and only that track's trex inside mvex. */
static int build_track_init(const byte_buf_t *source, size_t selected_track,
                            byte_buf_t *out)
{
    if (!source || !out || out->len != 0) {
        return -1;
    }

    size_t pos = 0;
    bool found_moov = false;
    bool kept_selected = false;
    while (pos < source->len) {
        mp4_box_t top;
        if (mp4_box_at(source->data, source->len, pos, &top) != 0) {
            goto fail;
        }
        if (top.type != MP4_TYPE('m', 'o', 'o', 'v')) {
            if (buf_append(out, source->data + top.offset, top.size) != 0) {
                goto fail;
            }
            pos += top.size;
            continue;
        }
        if (found_moov) {
            goto fail;
        }
        found_moov = true;

        size_t child_pos = top.offset + top.header_size;
        size_t child_end = top.offset + top.size;
        size_t track_index = 0;
        uint32_t selected_track_id = 0;
        while (child_pos < child_end) {
            mp4_box_t child;
            if (mp4_box_at(source->data, child_end, child_pos, &child) != 0) {
                goto fail;
            }
            if (child.type == MP4_TYPE('t', 'r', 'a', 'k')) {
                if (track_index == selected_track) {
                    if (trak_track_id(source->data + child.offset,
                                      child.size,
                                      &selected_track_id) != 0) {
                        goto fail;
                    }
                    kept_selected = true;
                }
                track_index++;
            }
            child_pos += child.size;
        }
        if (!kept_selected || selected_track_id == 0) {
            goto fail;
        }

        child_pos = top.offset + top.header_size;
        track_index = 0;
        size_t kept_body_size = 0;
        while (child_pos < child_end) {
            mp4_box_t child;
            if (mp4_box_at(source->data, child_end, child_pos, &child) != 0) {
                goto fail;
            }
            bool keep = child.type != MP4_TYPE('t', 'r', 'a', 'k') ||
                        track_index == selected_track;
            if (keep) {
                size_t output_size = child.size;
                if (child.type == MP4_TYPE('m', 'v', 'e', 'x') &&
                    filter_mvex(source->data + child.offset, child.size,
                                selected_track_id, NULL,
                                &output_size) != 0) {
                    goto fail;
                }
                if (output_size > SIZE_MAX - kept_body_size) {
                    goto fail;
                }
                kept_body_size += output_size;
            }
            if (child.type == MP4_TYPE('t', 'r', 'a', 'k')) {
                track_index++;
            }
            child_pos += child.size;
        }
        if (!kept_selected || kept_body_size > UINT32_MAX - 8u) {
            goto fail;
        }

        uint8_t moov_header[8];
        write_be32(moov_header, (uint32_t)(kept_body_size + 8u));
        write_be32(moov_header + 4, MP4_TYPE('m', 'o', 'o', 'v'));
        if (buf_append(out, moov_header, sizeof(moov_header)) != 0) {
            goto fail;
        }

        child_pos = top.offset + top.header_size;
        track_index = 0;
        while (child_pos < child_end) {
            mp4_box_t child;
            if (mp4_box_at(source->data, child_end, child_pos, &child) != 0) {
                goto fail;
            }
            bool keep = child.type != MP4_TYPE('t', 'r', 'a', 'k') ||
                        track_index == selected_track;
            if (keep) {
                if (child.type == MP4_TYPE('m', 'v', 'e', 'x')) {
                    size_t filtered_size = 0;
                    if (filter_mvex(source->data + child.offset, child.size,
                                    selected_track_id, out,
                                    &filtered_size) != 0) {
                        goto fail;
                    }
                } else if (buf_append(out, source->data + child.offset,
                                      child.size) != 0) {
                    goto fail;
                }
            }
            if (child.type == MP4_TYPE('t', 'r', 'a', 'k')) {
                track_index++;
            }
            child_pos += child.size;
        }
        pos += top.size;
    }
    return found_moov && kept_selected ? 0 : -1;

fail:
    buf_free(out);
    return -1;
}

static int read_bits(moq_bytes_t bytes, size_t *bit_offset, unsigned count,
                     uint32_t *out)
{
    if (!bit_offset || !out || (bytes.len > 0 && !bytes.data) || count > 32 ||
        bytes.len > SIZE_MAX / 8 || *bit_offset > bytes.len * 8 ||
        count > bytes.len * 8 - *bit_offset) {
        return -1;
    }
    uint32_t value = 0;
    for (unsigned i = 0; i < count; i++) {
        size_t bit = *bit_offset + i;
        value = (value << 1) |
                ((bytes.data[bit / 8] >> (7u - (unsigned)(bit % 8))) & 1u);
    }
    *bit_offset += count;
    *out = value;
    return 0;
}

static int parse_aac_config(moq_bytes_t config, uint32_t *object_type,
                            uint32_t *channel_count)
{
    size_t bit = 0;
    uint32_t aot = 0;
    uint32_t frequency_index = 0;
    uint32_t channel_config = 0;
    if (read_bits(config, &bit, 5, &aot) != 0) return -1;
    if (aot == 31) {
        uint32_t extension = 0;
        if (read_bits(config, &bit, 6, &extension) != 0) return -1;
        aot = 32u + extension;
    }
    if (read_bits(config, &bit, 4, &frequency_index) != 0) return -1;
    if (frequency_index == 15) {
        uint32_t explicit_frequency = 0;
        if (read_bits(config, &bit, 24, &explicit_frequency) != 0 ||
            explicit_frequency == 0) {
            return -1;
        }
    }
    if (read_bits(config, &bit, 4, &channel_config) != 0) return -1;

    /* ISO/IEC 14496-3 channelConfiguration values. Values 8..15 are reserved;
     * zero requires a Program Config Element, which is outside this small live
     * ingest parser and is rejected with a clear metadata error. */
    static const uint8_t channels_by_config[8] = {0, 1, 2, 3, 4, 5, 6, 8};
    if (aot == 0 || channel_config >= 8 ||
        channels_by_config[channel_config] == 0) {
        return -1;
    }
    *object_type = aot;
    *channel_count = channels_by_config[channel_config];
    return 0;
}

static int format_codec(track_slot_t *slot, const moq_cmaf_init_info_t *info)
{
    int n = -1;
    switch (info->codec_kind) {
    case MOQ_CMAF_CODEC_AVC:
        if (!info->codec_config.data || info->codec_config.len < 4) return -1;
        n = snprintf(slot->codec, sizeof(slot->codec), "avc1.%02x%02x%02x",
                     info->codec_config.data[1], info->codec_config.data[2],
                     info->codec_config.data[3]);
        break;
    case MOQ_CMAF_CODEC_AAC: {
        uint32_t object_type = 0;
        uint32_t ignored_channels = 0;
        if (parse_aac_config(info->codec_config, &object_type,
                             &ignored_channels) != 0) return -1;
        n = snprintf(slot->codec, sizeof(slot->codec), "mp4a.40.%u",
                     (unsigned)object_type);
        break;
    }
    case MOQ_CMAF_CODEC_OPUS:
        n = snprintf(slot->codec, sizeof(slot->codec), "opus");
        break;
    case MOQ_CMAF_CODEC_HEVC:
    case MOQ_CMAF_CODEC_AV1:
        /* Bare hvc1/av01 identifiers omit the RFC 6381 profile information
         * required by browser decoders. Do not publish misleading catalog
         * metadata until this small tool derives those full strings. */
        return -1;
    case MOQ_CMAF_CODEC_UNKNOWN:
    default:
        return -1;
    }
    return n > 0 && (size_t)n < sizeof(slot->codec) ? 0 : -1;
}

void clear_discovered_tracks(app_ctx_t *ctx)
{
    for (size_t i = 0; i < ctx->track_count; i++) {
        buf_free(&ctx->tracks[i].init);
    }
    memset(ctx->tracks, 0, sizeof(ctx->tracks));
    ctx->track_count = 0;
    ctx->init_ready = false;
    ctx->sender_ready = false;
}

int discover_tracks(app_ctx_t *ctx)
{
    if (!ctx || ctx->init.len == 0 || ctx->track_count != 0) {
        return -1;
    }

    size_t track_count = 0;
    if (init_track_count(&ctx->init, &track_count) != 0 ||
        track_count > MAX_TRACKS) {
        fprintf(stderr, "CMAF init has an invalid or unsupported track count (%zu; max %u)\n",
                track_count, (unsigned)MAX_TRACKS);
        return -1;
    }

    for (size_t i = 0; i < track_count; i++) {
        track_slot_t *slot = &ctx->tracks[i];
        if (build_track_init(&ctx->init, i, &slot->init) != 0) {
            fprintf(stderr, "failed to isolate CMAF init track %zu\n", i);
            clear_discovered_tracks(ctx);
            return -1;
        }

        moq_cmaf_init_info_t info;
        moq_cmaf_init_info_init(&info);
        moq_bytes_t init = {slot->init.data, slot->init.len};
        if (moq_cmaf_parse_init(init, &info) != MOQ_OK || info.track_id == 0 ||
            format_codec(slot, &info) != 0) {
            fprintf(stderr, "failed to parse supported metadata for CMAF track %zu\n", i);
            ctx->track_count = i + 1;
            clear_discovered_tracks(ctx);
            return -1;
        }
        if (track_for_id(ctx, info.track_id) != NULL) {
            fprintf(stderr, "duplicate CMAF track id %u\n", info.track_id);
            ctx->track_count = i + 1;
            clear_discovered_tracks(ctx);
            return -1;
        }

        bool audio = info.codec_kind == MOQ_CMAF_CODEC_AAC ||
                     info.codec_kind == MOQ_CMAF_CODEC_OPUS;
        slot->track_id = info.track_id;
        slot->media_type = audio ? MOQ_MEDIA_TYPE_AUDIO : MOQ_MEDIA_TYPE_VIDEO;
        slot->timescale = info.timescale;
        slot->width = info.width;
        slot->height = info.height;
        slot->samplerate = info.samplerate;
        slot->channel_count = info.channel_count;
        if (info.codec_kind == MOQ_CMAF_CODEC_AAC &&
            slot->channel_count == 0) {
            uint32_t ignored_object_type = 0;
            if (parse_aac_config(info.codec_config, &ignored_object_type,
                                 &slot->channel_count) != 0) {
                slot->channel_count = 0;
            }
        } else if (info.codec_kind == MOQ_CMAF_CODEC_OPUS &&
                   slot->channel_count == 0 && info.codec_config.data &&
                   info.codec_config.len >= 2) {
            /* dOps: version (1), outputChannelCount (1), then pre-skip. */
            slot->channel_count = info.codec_config.data[1];
        }
        int name_n = snprintf(slot->name, sizeof(slot->name), "%s_%u",
                              audio ? "soun" : "vide", info.track_id);
        if (name_n <= 0 || (size_t)name_n >= sizeof(slot->name) ||
            slot->timescale == 0 ||
            (audio && (slot->samplerate == 0 || slot->channel_count == 0)) ||
            (!audio && (slot->width == 0 || slot->height == 0))) {
            fprintf(stderr,
                    "incomplete metadata for CMAF track %u "
                    "(timescale=%u dimensions=%ux%u sample_rate=%u "
                    "channels=%u)\n",
                    slot->track_id, slot->timescale, slot->width,
                    slot->height, slot->samplerate, slot->channel_count);
            ctx->track_count = i + 1;
            clear_discovered_tracks(ctx);
            return -1;
        }
        if (audio) {
            int cc_n = snprintf(slot->channel_config,
                                sizeof(slot->channel_config), "%u",
                                slot->channel_count);
            if (cc_n <= 0 || (size_t)cc_n >= sizeof(slot->channel_config)) {
                ctx->track_count = i + 1;
                clear_discovered_tracks(ctx);
                return -1;
            }
        }
        ctx->track_count = i + 1;
    }

    ctx->init_ready = true;
    return 0;
}

void fill_track_cfg(const track_slot_t *slot, moq_media_track_cfg_t *tc)
{
    moq_media_track_cfg_init(tc);
    tc->name.data = (const uint8_t *)slot->name;
    tc->name.len = strlen(slot->name);
    tc->media_type = slot->media_type;
    tc->packaging = MOQ_MEDIA_PACKAGING_CMAF;
    tc->codec.data = (const uint8_t *)slot->codec;
    tc->codec.len = strlen(slot->codec);
    tc->timescale = slot->timescale;
    tc->init_data.data = slot->init.data;
    tc->init_data.len = slot->init.len;
    tc->is_live = true;
    tc->width = slot->width;
    tc->height = slot->height;
    tc->samplerate = slot->samplerate;
    if (slot->media_type == MOQ_MEDIA_TYPE_AUDIO) {
        tc->channel_config.data = (const uint8_t *)slot->channel_config;
        tc->channel_config.len = strlen(slot->channel_config);
    }
    tc->bitrate = slot->media_type == MOQ_MEDIA_TYPE_AUDIO ? 128000 : 2500000;
}

static int ensure_tracks_added(moq_media_sender_t *tx, app_ctx_t *ctx)
{
    if (!ctx->init_ready) {
        return 0;
    }
    for (size_t i = 0; i < ctx->track_count; i++) {
        track_slot_t *slot = &ctx->tracks[i];
        if (slot->added) {
            continue;
        }

        moq_media_track_cfg_t tc;
        fill_track_cfg(slot, &tc);

        moq_result_t rc = moq_media_sender_add_track(tx, &tc, &slot->handle);
        if (rc != MOQ_OK) {
            fprintf(stderr, "add_track(%s) failed: %d\n", slot->name, (int)rc);
            return -1;
        }
        slot->added = true;
        fprintf(stderr,
                "track added: %s (id=%u codec=%s init=%zu bytes)\n",
                slot->name, slot->track_id, slot->codec, slot->init.len);
    }
    ctx->sender_ready = true;
    if (!moq_media_sender_is_ready(tx)) {
        fprintf(stderr, "waiting for catalog publish...\n");
        for (int i = 0; i < 20 && !moq_media_sender_is_ready(tx); i++) {
            if (moq_media_sender_is_fatal(tx) || moq_media_sender_is_closed(tx)) {
                fprintf(stderr, "sender fatal before ready: %llu\n",
                        (unsigned long long)moq_media_sender_fatal_code(tx));
                return -1;
            }
            (void)moq_media_sender_wait(tx, 100000);
        }
        if (moq_media_sender_is_ready(tx)) {
            fprintf(stderr, "sender ready (namespace + catalog published)\n");
        } else {
            fprintf(stderr, "sender not ready after 2s; writing anyway\n");
        }
    }
    return 0;
}

static int publish_fragment(moq_media_sender_t *tx, app_ctx_t *ctx,
                            const uint8_t *fragment, size_t fragment_len)
{
    moq_cmaf_fragment_info_t finfo;
    moq_cmaf_sample_t stack_samples[64];
    moq_cmaf_sample_t *samples = stack_samples;
    size_t sample_cap = sizeof(stack_samples) / sizeof(stack_samples[0]);
    moq_cmaf_fragment_info_init(&finfo, samples, sample_cap);

    moq_bytes_t frag_bytes = {fragment, fragment_len};
    moq_result_t pr = moq_cmaf_parse_fragment(frag_bytes, &finfo);
    if (pr == MOQ_ERR_BUFFER) {
        sample_cap = finfo.sample_count;
        if (sample_cap == 0 || sample_cap > SIZE_MAX / sizeof(*samples)) {
            return -1;
        }
        samples = malloc(sample_cap * sizeof(*samples));
        if (!samples) {
            return -1;
        }
        moq_cmaf_fragment_info_init(&finfo, samples, sample_cap);
        pr = moq_cmaf_parse_fragment(frag_bytes, &finfo);
    }
    if (pr != MOQ_OK) {
        fprintf(stderr, "fragment parse failed: %d\n", (int)pr);
        if (samples != stack_samples) free(samples);
        return -1;
    }

    uint32_t track_id = finfo.track_id;
    track_slot_t *slot = track_for_id(ctx, track_id);
    if (!slot || !slot->handle) {
        fprintf(stderr, "fragment references undeclared track id %u\n", track_id);
        if (samples != stack_samples) free(samples);
        return -1;
    }

    uint32_t parsed_flags = 0;
    if (finfo.sample_count > 0) {
        parsed_flags = finfo.samples[0].flags;
    }
    uint32_t first_flags =
        cmaf_first_sample_flags(fragment, fragment_len, parsed_flags);
    bool keyframe = (first_flags & 0x00010000u) == 0;
    if (samples != stack_samples) free(samples);

    moq_cmaf_object_report_t report;
    moq_cmaf_object_report_init(&report);
    moq_cmaf_init_info_t init_info;
    moq_cmaf_init_info_init(&init_info);
    if (moq_cmaf_parse_init(
            (moq_bytes_t){slot->init.data, slot->init.len}, &init_info) != MOQ_OK ||
        moq_cmaf_validate_object(&init_info, frag_bytes, &report) != MOQ_OK) {
        fprintf(stderr, "invalid CMAF object for %s (reason=%d)\n",
                slot->name, (int)report.reason);
        return -1;
    }

    /* The stdin fragment buffer is temporary. Create an owning rcbuf copy;
     * wrapping it and freeing the source before write() would leave the sender
     * holding a dangling pointer. */
    moq_rcbuf_t *payload_rc = NULL;
    if (moq_rcbuf_create(moq_alloc_default(), fragment, fragment_len,
                         &payload_rc) != MOQ_OK) {
        return -1;
    }

    moq_media_send_object_t obj;
    memset(&obj, 0, sizeof(obj));
    obj.struct_size = sizeof(obj);
    obj.payload = payload_rc;
    obj.is_sync = keyframe || report.starts_with_sync;
    obj.starts_group = obj.is_sync;
    if (obj.is_sync) {
        obj.has_sap_type = true;
        obj.sap_type = MOQ_SAP_TYPE_1;
    } else if (report.sap_type != MOQ_SAP_UNKNOWN) {
        obj.has_sap_type = true;
        obj.sap_type = report.sap_type;
    }

    /* Default pre-ready bound is smaller than one 720p GOP, so write()
     * returns WOULD_BLOCK with no enqueue. Dropping that is how canary
     * jobs advertised vide_1/soun_2 and then sent zero media. */
    enum { WRITE_WAIT_US = 200000 };
    const int write_tries = moq_media_sender_is_ready(tx) ? 50 : 3;
    struct timespec t0;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    moq_result_t wr = MOQ_ERR_WOULD_BLOCK;
    int attempt = 0;
    for (; attempt < write_tries; attempt++) {
        if (moq_media_sender_is_fatal(tx) || moq_media_sender_is_closed(tx)) {
            wr = MOQ_ERR_CLOSED;
            break;
        }
        wr = moq_media_sender_write(tx, slot->handle, &obj);
        if (wr != MOQ_ERR_WOULD_BLOCK) {
            break;
        }
        if (attempt == 0) {
            fprintf(stderr,
                    "write(%s) block bytes=%zu is_sync=%d flags=0x%08x "
                    "parsed=0x%08x starts_sync=%d\n",
                    slot->name, fragment_len, (int)obj.is_sync, first_flags,
                    parsed_flags, (int)report.starts_with_sync);
        }
        if (fmp4_moq_should_stop(NULL)) {
            break;
        }
        (void)moq_media_sender_wait(tx, WRITE_WAIT_US);
    }
    if (wr == MOQ_ERR_WOULD_BLOCK || wr == MOQ_ERR_CLOSED) {
        moq_rcbuf_decref(payload_rc);
        static unsigned drop_n;
        drop_n++;
        /* Always log drop_n so helper scrape / HUD can show the real count
         * (sampled first-3-then-every-50 hid 47 drops as "(3)"). */
        fprintf(stderr,
                "write(%s) would block after retry; dropping fragment (%u)\n",
                slot->name, drop_n);
        return 0;
    }
    if (wr != MOQ_OK) {
        moq_rcbuf_decref(payload_rc);
        fprintf(stderr, "write(%s) failed: %d\n", slot->name, (int)wr);
        return -1;
    }
    struct timespec t1;
    clock_gettime(CLOCK_MONOTONIC, &t1);
    long pub_ms = (t1.tv_sec - t0.tv_sec) * 1000L + (t1.tv_nsec - t0.tv_nsec) / 1000000L;
    static unsigned sent_n;
    sent_n++;
    /* Always log a stall; otherwise sample so webcam vs file is comparable. */
    if (pub_ms >= 20 || attempt > 1 || (sent_n % 25u) == 0) {
        fprintf(stderr, "pub track=%s ms=%ld tries=%d bytes=%zu\n",
                slot->name, pub_ms, attempt + 1, fragment_len);
    }
    /* Video group cadence vs wall clock — webcam 0.8↔1.3× shows up here. */
    if (slot->media_type == MOQ_MEDIA_TYPE_VIDEO && obj.starts_group) {
        static struct timespec last_vide;
        static int have_vide;
        long dt_ms = -1;
        if (have_vide) {
            dt_ms = (t1.tv_sec - last_vide.tv_sec) * 1000L +
                    (t1.tv_nsec - last_vide.tv_nsec) / 1000000L;
        }
        last_vide = t1;
        have_vide = 1;
        fprintf(stderr, "obj vide wall_dt_ms=%ld bytes=%zu sync=%d\n",
                dt_ms, fragment_len, (int)obj.is_sync);
    }
    return 0;
}

static void drain_before_stop(moq_endpoint_t *ep, int likely_live)
{
    uint64_t timeout = likely_live ? ENDPOINT_DRAIN_TIMEOUT_US : 250000;
    moq_result_t dr = moq_endpoint_drain(ep, timeout);
    if (dr == MOQ_DONE && likely_live) {
        fprintf(stderr, "endpoint drain timed out; stopping anyway\n");
    }
}

void init_sender_cfg(moq_media_sender_cfg_t *cfg, moq_bytes_t *namespace_parts,
                     size_t namespace_count)
{
    /* Pointer-only init_live() only stamps the frozen v0 prefix. Sized
     * init is required for publish_tracks and a matching struct_size. */
    moq_media_sender_cfg_init_live_sized(cfg, sizeof(*cfg));
    /* Lossless: block the writer instead of dropping the first GOP. ffmpeg
     * already rate-limits; a 200ms stall beats a black playa canvas. */
    cfg->backpressure = MOQ_MEDIA_SEND_BP_BLOCK_TIMEOUT;
    cfg->block_timeout_us = 200000;
    cfg->queue_max_objects = 256;
    cfg->queue_max_bytes = 16u * 1024u * 1024u;
    cfg->pre_ready_max_objects = 128;
    cfg->pre_ready_max_bytes = 8u * 1024u * 1024u;
    cfg->publish_tracks = true;
    cfg->endpoint = NULL;
    cfg->namespace_.parts = namespace_parts;
    cfg->namespace_.count = namespace_count;
}

/* libmoq live-writes the catalog on the first sender_hook tick after
 * attach. If we attach at CONNECT (before moov), that object is
 * `{tracks:[]}` and a one-shot Joining FETCH never sees vide_1. Delay
 * endpoint+sender until init is parsed, then add_track immediately so
 * the first live catalog already has vide/soun + init. */
static void *endpoint_connect_main(void *arg)
{
    fmp4_moq_bridge_t *b = arg;
    /* Test hook: hold CONNECT so lavfi/webcam bitrate can fill the OS pipe
     * unless main.c is already draining stdin on another thread. */
    const char *delay_raw = getenv("MOQ5_CONNECT_DELAY_MS");
    if (delay_raw && delay_raw[0]) {
        int delay_ms = atoi(delay_raw);
        if (delay_ms > 0) {
            fprintf(stderr, "MOQ5_CONNECT_DELAY_MS=%d (test hook)\n", delay_ms);
            usleep((useconds_t)delay_ms * 1000u);
        }
    }

    moq_endpoint_cfg_t ec;
    moq_endpoint_cfg_init(&ec);
    ec.url.data = (const uint8_t *)b->urlbuf;
    ec.url.len = strlen(b->urlbuf);
    ec.insecure_skip_verify = b->insecure_skip_verify != 0;

    moq_endpoint_t *ep = NULL;
    moq_result_t rc = moq_endpoint_connect(&ec, &ep);
    pthread_mutex_lock(&b->connect_mu);
    b->ep = ep;
    b->connect_rc = rc;
    b->connect_done = 1;
    pthread_cond_broadcast(&b->connect_cv);
    pthread_mutex_unlock(&b->connect_mu);
    if (rc != MOQ_OK) {
        fprintf(stderr, "endpoint connect failed: %d\n", (int)rc);
    } else {
        /* Orchestrator treats connection_id= as a live WT session. Print it
         * at CONNECT, not only after moov attach — helper finalize used to
         * say "never connected" when attach had not run yet. */
        fprintf(stderr, "connection_id=moq5-wt ns=%s\n", b->nsbuf);
        fprintf(stderr, "webtransport connected (sender attach still waits for moov)\n");
    }
    return NULL;
}

static int start_endpoint_connect(fmp4_moq_bridge_t *b)
{
    if (b->connect_started) {
        return 0;
    }
    if (b->urlbuf[0] == '\0') {
        fprintf(stderr, "endpoint connect failed: %d\n", (int)MOQ_ERR_INVAL);
        return -1;
    }
    b->connect_rc = MOQ_ERR_INVAL;
    if (pthread_create(&b->connect_th, NULL, endpoint_connect_main, b) != 0) {
        fprintf(stderr, "endpoint connect thread failed; connecting inline\n");
        endpoint_connect_main(b);
        return b->connect_rc == MOQ_OK ? 0 : -1;
    }
    b->connect_started = 1;
    fprintf(stderr, "starting WebTransport CONNECT (before moov)\n");
    return 0;
}

static int wait_endpoint_connected(fmp4_moq_bridge_t *b)
{
    if (!b->connect_started && !b->connect_done) {
        if (start_endpoint_connect(b) != 0) {
            return -1;
        }
    }
    pthread_mutex_lock(&b->connect_mu);
    while (!b->connect_done) {
        pthread_cond_wait(&b->connect_cv, &b->connect_mu);
    }
    moq_result_t rc = b->connect_rc;
    pthread_mutex_unlock(&b->connect_mu);
    if (rc != MOQ_OK || b->ep == NULL) {
        fprintf(stderr, "endpoint connect failed: %d\n", (int)rc);
        return -1;
    }
    return 0;
}

static int ensure_sender_attached(fmp4_moq_bridge_t *b)
{
    if (b->tx) {
        return 0;
    }
    if (wait_endpoint_connected(b) != 0) {
        return -1;
    }

    moq_media_sender_cfg_t scfg;
    init_sender_cfg(&scfg, b->ns_parts, b->ns_count);
    moq_result_t rc = moq_media_sender_attach(b->ep, &scfg, &b->tx);
    if (rc != MOQ_OK) {
        fprintf(stderr, "sender attach failed: %d\n", (int)rc);
        moq_endpoint_stop(b->ep);
        moq_endpoint_destroy(b->ep);
        b->ep = NULL;
        return -1;
    }
    /* Same token the orchestrator treats as a live WebTransport session. */
    fprintf(stderr, "connection_id=moq5-wt ns=%s\n", b->nsbuf);
    return 0;
}

static int activate_tracks(fmp4_moq_bridge_t *b)
{
    if (b->ctx.sender_ready) {
        return 0;
    }
    if (!b->ctx.init_ready) {
        if (discover_tracks(&b->ctx) != 0) {
            return -1;
        }
    }
    fprintf(stderr,
            "attaching sender after CMAF init (%zu tracks; first live "
            "catalog will include vide/soun)\n",
            b->ctx.track_count);
    if (ensure_sender_attached(b) != 0) {
        return -1;
    }
    return ensure_tracks_added(b->tx, &b->ctx);
}

static int ensure_ready_for_fragment(fmp4_moq_bridge_t *b)
{
    if (b->ctx.sender_ready) {
        return 0;
    }
    if (b->ctx.init.len > 0) {
        return activate_tracks(b);
    }
    return 0;
}

static int finish_kept_box(fmp4_moq_bridge_t *b, const char *type)
{
    if (strcmp(type, "moov") == 0 && !b->ctx.init_ready) {
        if (activate_tracks(b) != 0) {
            return -1;
        }
        if (b->tx && moq_media_sender_is_ready(b->tx)) {
            b->session_live = 1;
        }
    }
    if (strcmp(type, "moof") == 0) {
        b->have_moof = true;
        return 0;
    }
    if (strcmp(type, "mdat") == 0) {
        if (ensure_ready_for_fragment(b) != 0) {
            return -1;
        }
        byte_buf_t fragment = {0};
        if (buf_append(&fragment, b->pending_moof.data, b->pending_moof.len) != 0 ||
            buf_append(&fragment, b->pending_mdat.data, b->pending_mdat.len) != 0) {
            buf_free(&fragment);
            return -1;
        }
        int pr = publish_fragment(b->tx, &b->ctx, fragment.data, fragment.len);
        buf_free(&fragment);
        buf_free(&b->pending_moof);
        buf_free(&b->pending_mdat);
        b->have_moof = false;
        if (pr == 0 && b->tx && moq_media_sender_is_ready(b->tx)) {
            b->session_live = 1;
        }
        return pr;
    }
    return 0;
}

static int parse_stream_header(const uint8_t *hdr, size_t hdr_len,
                               size_t *header_size, size_t *body_size,
                               char type[5])
{
    if (hdr_len < 8) {
        return 0;
    }
    uint32_t size32 = read_be32(hdr);
    memcpy(type, hdr + 4, 4);
    type[4] = '\0';

    if (size32 == 1) {
        if (hdr_len < 16) {
            return 0;
        }
        uint64_t size64 = read_be64(hdr + 8);
        if (size64 < 16 || size64 - 16 > SIZE_MAX) {
            return -1;
        }
        *header_size = 16;
        *body_size = (size_t)(size64 - 16);
        return 1;
    }
    if (size32 == 0 || size32 < 8) {
        return -1;
    }
    *header_size = 8;
    *body_size = size32 - 8u;
    return 1;
}

static void parser_reset_header(box_parser_t *p)
{
    p->hdr_got = 0;
    p->header_size = 0;
    p->body_size = 0;
    p->body_got = 0;
    p->type[0] = '\0';
    p->phase = BOX_PHASE_HEADER;
    p->dest = NULL;
}

static int parser_accept_header(fmp4_moq_bridge_t *b)
{
    box_parser_t *p = &b->parser;
    const int is_ftyp = strcmp(p->type, "ftyp") == 0;
    const int is_moov = strcmp(p->type, "moov") == 0;
    const int is_moof = strcmp(p->type, "moof") == 0;
    const int is_mdat = strcmp(p->type, "mdat") == 0;

    if (b->have_moof && !is_mdat) {
        fprintf(stderr, "expected mdat after moof, got %s\n", p->type);
        return -1;
    }

    if (is_ftyp || is_moov) {
        p->dest = &b->ctx.init;
        p->phase = BOX_PHASE_KEEP;
    } else if (is_moof) {
        p->dest = &b->pending_moof;
        p->phase = BOX_PHASE_KEEP;
    } else if (is_mdat && b->have_moof) {
        p->dest = &b->pending_mdat;
        p->phase = BOX_PHASE_KEEP;
    } else {
        p->phase = BOX_PHASE_SKIP;
        p->dest = NULL;
        return 0;
    }

    if (buf_append(p->dest, p->hdr, p->header_size) != 0) {
        return -1;
    }
    return 0;
}

void fmp4_moq_request_stop(void)
{
    g_stop = 1;
}

int fmp4_moq_should_stop(const fmp4_moq_bridge_t *b)
{
    if (g_stop) {
        return 1;
    }
    if (b && b->deadline > 0 && time(NULL) >= b->deadline) {
        return 1;
    }
    return 0;
}

fmp4_moq_bridge_t *fmp4_moq_connect(const char *url, const char *namespace_,
                                    const fmp4_moq_opts_t *opts)
{
    static const fmp4_moq_opts_t k_zero_opts;
    if (!url || !namespace_ || url[0] == '\0' || namespace_[0] == '\0') {
        fprintf(stderr, "endpoint connect failed: %d\n", (int)MOQ_ERR_INVAL);
        return NULL;
    }
    if (!opts) {
        opts = &k_zero_opts;
    }

    if (opts->qlog_dir != NULL && opts->qlog_dir[0] != '\0') {
        /* libmoq ep_configure_quic honors MOQ_QLOG_DIR via picoquic_set_qlog. */
        setenv("MOQ_QLOG_DIR", opts->qlog_dir, 1);
        fprintf(stderr, "picoquic qlog enabled: %s\n", opts->qlog_dir);
    }

    fmp4_moq_bridge_t *b = calloc(1, sizeof(*b));
    if (!b) {
        return NULL;
    }
    if (strlen(url) >= sizeof(b->urlbuf)) {
        fprintf(stderr, "endpoint connect failed: %d\n", (int)MOQ_ERR_INVAL);
        free(b);
        return NULL;
    }
    memcpy(b->urlbuf, url, strlen(url) + 1);
    snprintf(b->nsbuf, sizeof(b->nsbuf), "%s", namespace_);
    b->ns_count = split_namespace(b->nsbuf, b->ns_parts, 32);
    b->insecure_skip_verify = opts->insecure_skip_verify != 0;
    b->duration_sec = opts->duration_sec;
    if (b->duration_sec > 0) {
        b->deadline = time(NULL) + b->duration_sec;
    }
    parser_reset_header(&b->parser);

    /* Handshake now; attach still waits for moov so the first live catalog
     * has vide/soun instead of `{tracks:[]}`. */
    pthread_mutex_init(&b->connect_mu, NULL);
    pthread_cond_init(&b->connect_cv, NULL);
    if (start_endpoint_connect(b) != 0) {
        pthread_cond_destroy(&b->connect_cv);
        pthread_mutex_destroy(&b->connect_mu);
        free(b);
        return NULL;
    }
    fprintf(stderr, "waiting for ftyp+moov before sender attach\n");
    return b;
}

int fmp4_moq_feed(fmp4_moq_bridge_t *b, const uint8_t *data, size_t len)
{
    if (!b || (len > 0 && data == NULL)) {
        return -1;
    }
    if (fmp4_moq_should_stop(b)) {
        return 0;
    }

    size_t off = 0;
    while (off < len) {
        if (fmp4_moq_should_stop(b)) {
            return 0;
        }

        box_parser_t *p = &b->parser;
        if (p->phase == BOX_PHASE_HEADER) {
            size_t want = p->hdr_got < 8 ? 8 - p->hdr_got : 16 - p->hdr_got;
            size_t take = len - off < want ? len - off : want;
            memcpy(p->hdr + p->hdr_got, data + off, take);
            p->hdr_got += take;
            off += take;

            int hr = parse_stream_header(p->hdr, p->hdr_got, &p->header_size,
                                         &p->body_size, p->type);
            if (hr == 0) {
                continue;
            }
            if (hr < 0) {
                fprintf(stderr, "truncated or malformed MP4 box header\n");
                return -1;
            }
            if (parser_accept_header(b) != 0) {
                return -1;
            }
            if (p->phase == BOX_PHASE_KEEP && p->body_size == 0) {
                if (finish_kept_box(b, p->type) != 0) {
                    return -1;
                }
                parser_reset_header(p);
            }
            continue;
        }

        size_t remain = p->body_size - p->body_got;
        size_t take = len - off < remain ? len - off : remain;
        if (p->phase == BOX_PHASE_KEEP) {
            if (take > 0 && buf_append(p->dest, data + off, take) != 0) {
                return -1;
            }
        }
        p->body_got += take;
        off += take;
        if (p->body_got < p->body_size) {
            continue;
        }
        if (p->phase == BOX_PHASE_KEEP && finish_kept_box(b, p->type) != 0) {
            return -1;
        }
        parser_reset_header(p);
    }
    return 0;
}

int fmp4_moq_close(fmp4_moq_bridge_t *b)
{
    if (!b) {
        return -1;
    }

    int rc = 0;
    const int stopped = fmp4_moq_should_stop(b);
    if (!stopped) {
        if (b->have_moof) {
            fprintf(stderr, "expected mdat after moof, got %s\n",
                    b->parser.type);
            rc = -1;
        } else if (b->parser.hdr_got > 0 ||
                   b->parser.phase != BOX_PHASE_HEADER) {
            fprintf(stderr, "truncated or malformed MP4 box header\n");
            rc = -1;
        }
    }

    if (b->connect_started) {
        pthread_join(b->connect_th, NULL);
        b->connect_started = 0;
    }
    pthread_cond_destroy(&b->connect_cv);
    pthread_mutex_destroy(&b->connect_mu);
    if (b->tx) {
        moq_media_sender_destroy(b->tx);
        b->tx = NULL;
    }
    if (b->ep) {
        drain_before_stop(b->ep, b->session_live);
        moq_endpoint_stop(b->ep);
        moq_endpoint_destroy(b->ep);
        b->ep = NULL;
    }
    clear_discovered_tracks(&b->ctx);
    buf_free(&b->ctx.init);
    buf_free(&b->pending_moof);
    buf_free(&b->pending_mdat);
    free(b);
    return rc;
}
