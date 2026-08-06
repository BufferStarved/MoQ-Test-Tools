/*
 * moq5-fmp4-publish — read fragmented MP4 from stdin, publish via libmoq service tier.
 *
 * Intended pipeline:
 *   ffmpeg ... -movflags \
 *     +frag_keyframe+empty_moov+default_base_moof+separate_moof \
 *     -f mp4 pipe:1 | moq5-fmp4-publish <url> <namespace>
 *
 * separate_moof is required: each moof+mdat pair must belong to one track.
 * The init segment may contain several traks; each is advertised separately.
 *
 * Usage:
 *   moq5-fmp4-publish <url> <namespace> [--insecure-skip-verify] [--duration SEC]
 *                                      [--qlog-dir PATH]
 */

#include <moq/cmaf.h>
#include <moq/endpoint.h>
#include <moq/media_sender.h>
#include <moq/rcbuf.h>
#include <moq/types.h>

#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t g_stop = 0;

enum { MAX_TRACKS = 4, ENDPOINT_DRAIN_TIMEOUT_US = 5000000 };

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

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

static int buf_reserve(byte_buf_t *b, size_t need)
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

static int buf_append(byte_buf_t *b, const uint8_t *src, size_t len)
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

static uint32_t read_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static uint64_t read_be64(const uint8_t *p)
{
    return ((uint64_t)read_be32(p) << 32) | read_be32(p + 4);
}

static void write_be32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value >> 24);
    p[1] = (uint8_t)(value >> 16);
    p[2] = (uint8_t)(value >> 8);
    p[3] = (uint8_t)value;
}

#define MP4_TYPE(a, b, c, d) \
    (((uint32_t)(a) << 24) | ((uint32_t)(b) << 16) | \
     ((uint32_t)(c) << 8) | (uint32_t)(d))

static int mp4_box_at(const uint8_t *data, size_t len, size_t offset,
                      mp4_box_t *out)
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

static void buf_free(byte_buf_t *b)
{
    free(b->data);
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
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
static int read_box_header(int fd, stream_box_header_t *out)
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

static int read_box_body(int fd, size_t body_len, byte_buf_t *out)
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

static int discard_box_body(int fd, size_t body_len)
{
    uint8_t scratch[4096];
    while (body_len > 0) {
        size_t chunk = body_len < sizeof(scratch) ? body_len : sizeof(scratch);
        if (read_exact(fd, scratch, chunk) != 0) {
            return -1;
        }
        body_len -= chunk;
    }
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

static track_slot_t *track_for_id(app_ctx_t *ctx, uint32_t track_id)
{
    for (size_t i = 0; i < ctx->track_count; i++) {
        if (ctx->tracks[i].track_id == track_id) {
            return &ctx->tracks[i];
        }
    }
    return NULL;
}

static int init_track_count(const byte_buf_t *init, size_t *out_count)
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

static void clear_discovered_tracks(app_ctx_t *ctx)
{
    for (size_t i = 0; i < ctx->track_count; i++) {
        buf_free(&ctx->tracks[i].init);
    }
    memset(ctx->tracks, 0, sizeof(ctx->tracks));
    ctx->track_count = 0;
    ctx->init_ready = false;
    ctx->sender_ready = false;
}

static int discover_tracks(app_ctx_t *ctx)
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

static void fill_track_cfg(const track_slot_t *slot,
                           moq_media_track_cfg_t *tc)
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
    return 0;
}

static int publish_fragment(moq_media_sender_t *tx, app_ctx_t *ctx, const uint8_t *fragment,
                            size_t fragment_len)
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

    bool keyframe = false;
    if (finfo.sample_count > 0) {
        keyframe = (finfo.samples[0].flags & 0x00010000u) == 0;
    }
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
    obj.starts_group = keyframe || report.starts_with_sync;
    if (report.sap_type != MOQ_SAP_UNKNOWN) {
        obj.has_sap_type = true;
        obj.sap_type = report.sap_type;
    }

    moq_result_t wr = moq_media_sender_write(tx, slot->handle, &obj);
    if (wr == MOQ_ERR_WOULD_BLOCK) {
        moq_rcbuf_decref(payload_rc);
        fprintf(stderr, "write(%s) would block; dropping live fragment\n",
                slot->name);
        return 0;
    }
    if (wr != MOQ_OK) {
        moq_rcbuf_decref(payload_rc);
        fprintf(stderr, "write(%s) failed: %d\n", slot->name, (int)wr);
        return -1;
    }
    return 0;
}

static void drain_before_stop(moq_endpoint_t *ep)
{
    moq_result_t dr = moq_endpoint_drain(ep, ENDPOINT_DRAIN_TIMEOUT_US);
    if (dr == MOQ_DONE) {
        fprintf(stderr, "endpoint drain timed out; stopping anyway\n");
    }
}

static int ingest_stdin(moq_media_sender_t *tx, app_ctx_t *ctx, int duration_sec)
{
    time_t deadline = duration_sec > 0 ? time(NULL) + duration_sec : 0;

    while (!g_stop) {
        if (deadline > 0 && time(NULL) >= deadline) {
            break;
        }

        stream_box_header_t box;
        int header_rc = read_box_header(STDIN_FILENO, &box);
        if (header_rc == 1) {
            break;
        }
        if (header_rc != 0) {
            fprintf(stderr, "truncated or malformed MP4 box header\n");
            return -1;
        }

        if (strcmp(box.type, "ftyp") == 0 || strcmp(box.type, "moov") == 0) {
            if (buf_append(&ctx->init, box.bytes, box.header_size) != 0) {
                return -1;
            }
            if (read_box_body(STDIN_FILENO, box.body_size, &ctx->init) != 0) {
                return -1;
            }
            if (strcmp(box.type, "moov") == 0 && !ctx->init_ready) {
                if (discover_tracks(ctx) != 0) {
                    return -1;
                }
                if (ensure_tracks_added(tx, ctx) != 0) {
                    return -1;
                }
            }
            continue;
        }

        if (strcmp(box.type, "moof") == 0) {
            byte_buf_t moof = {0};
            if (buf_append(&moof, box.bytes, box.header_size) != 0) {
                return -1;
            }
            if (read_box_body(STDIN_FILENO, box.body_size, &moof) != 0) {
                buf_free(&moof);
                return -1;
            }

            stream_box_header_t mdat_header;
            if (read_box_header(STDIN_FILENO, &mdat_header) != 0 ||
                strcmp(mdat_header.type, "mdat") != 0) {
                buf_free(&moof);
                fprintf(stderr, "expected mdat after moof, got %s\n",
                        mdat_header.type);
                return -1;
            }

            byte_buf_t mdat = {0};
            if (buf_append(&mdat, mdat_header.bytes,
                           mdat_header.header_size) != 0 ||
                read_box_body(STDIN_FILENO, mdat_header.body_size, &mdat) != 0) {
                buf_free(&moof);
                buf_free(&mdat);
                return -1;
            }

            if (!ctx->sender_ready) {
                if (ctx->init.len > 0 && !ctx->init_ready) {
                    if (discover_tracks(ctx) != 0 ||
                        ensure_tracks_added(tx, ctx) != 0) {
                        buf_free(&moof);
                        buf_free(&mdat);
                        return -1;
                    }
                }
            }

            byte_buf_t fragment = {0};
            if (buf_append(&fragment, moof.data, moof.len) != 0 ||
                buf_append(&fragment, mdat.data, mdat.len) != 0) {
                buf_free(&moof);
                buf_free(&mdat);
                buf_free(&fragment);
                return -1;
            }

            if (publish_fragment(tx, ctx, fragment.data, fragment.len) != 0) {
                buf_free(&moof);
                buf_free(&mdat);
                buf_free(&fragment);
                return -1;
            }

            buf_free(&moof);
            buf_free(&mdat);
            buf_free(&fragment);
            continue;
        }

        /* Skip unknown boxes without allocating their declared size. */
        if (discard_box_body(STDIN_FILENO, box.body_size) != 0) {
            return -1;
        }
    }
    return 0;
}

static void init_sender_cfg(moq_media_sender_cfg_t *cfg,
                            moq_bytes_t *namespace_parts,
                            size_t namespace_count)
{
    /* Newer libmoq versions freeze the pointer-only initializer at their v0
     * ABI prefix. Prefer the sized form there; the fallback supports the
     * current public release, whose pointer-only initializer still covers the
     * complete struct. */
#if MOQ5_HAVE_SIZED_SENDER_CFG_INIT
    moq_media_sender_cfg_init_live_sized(cfg, sizeof(*cfg));
#else
    moq_media_sender_cfg_init_live(cfg);
#endif
    /* This process publishes into a relay: push the generated catalog and
     * every media track instead of waiting for direct pull subscriptions. */
    cfg->publish_tracks = true;
    cfg->endpoint = NULL;
    cfg->namespace_.parts = namespace_parts;
    cfg->namespace_.count = namespace_count;
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr,
                "usage: %s <url> <namespace> [--insecure-skip-verify] [--duration SEC] "
                "[--qlog-dir PATH]\n",
                argv[0]);
        return 2;
    }

    const char *url = argv[1];
    char nsbuf[256];
    snprintf(nsbuf, sizeof(nsbuf), "%s", argv[2]);
    bool insecure = false;
    int duration_sec = 0;
    const char *qlog_dir = NULL;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--insecure-skip-verify") == 0) {
            insecure = true;
        } else if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) {
            duration_sec = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--qlog-dir") == 0 && i + 1 < argc) {
            qlog_dir = argv[++i];
        }
    }

    if (qlog_dir != NULL && qlog_dir[0] != '\0') {
        setenv("MOQ_QLOG_DIR", qlog_dir, 1);
        fprintf(stderr, "picoquic qlog enabled: %s\n", qlog_dir);
    }

    signal(SIGINT, on_signal);
    signal(SIGPIPE, SIG_IGN);

    moq_bytes_t ns_parts[32];
    size_t ns_count = split_namespace(nsbuf, ns_parts, 32);

    moq_endpoint_cfg_t ec;
    moq_endpoint_cfg_init(&ec);
    ec.url.data = (const uint8_t *)url;
    ec.url.len = strlen(url);
    ec.insecure_skip_verify = insecure;

    moq_endpoint_t *ep = NULL;
    moq_result_t rc = moq_endpoint_connect(&ec, &ep);
    if (rc != MOQ_OK) {
        fprintf(stderr, "endpoint connect failed: %d\n", (int)rc);
        return 1;
    }

    moq_media_sender_cfg_t scfg;
    init_sender_cfg(&scfg, ns_parts, ns_count);

    moq_media_sender_t *tx = NULL;
    rc = moq_media_sender_attach(ep, &scfg, &tx);
    if (rc != MOQ_OK) {
        fprintf(stderr, "sender attach failed: %d\n", (int)rc);
        moq_endpoint_stop(ep);
        moq_endpoint_destroy(ep);
        return 1;
    }

    app_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));

    fprintf(stderr, "moq5-fmp4-publish: url=%s namespace=%s\n", url, nsbuf);
    int ingest_rc = ingest_stdin(tx, &ctx, duration_sec);

    moq_media_sender_destroy(tx);
    drain_before_stop(ep);
    moq_endpoint_stop(ep);
    moq_endpoint_destroy(ep);
    clear_discovered_tracks(&ctx);
    buf_free(&ctx.init);

    return ingest_rc == 0 ? 0 : 1;
}
