/*
 * moq5-fmp4-publish — read fragmented MP4 from stdin, publish via libmoq service tier.
 *
 * Intended pipeline:
 *   ffmpeg -f mp4 -movflags +frag_keyframe+empty_moov+... pipe:1 | moq5-fmp4-publish <url> <namespace>
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
    uint32_t track_id;
    char name[32];
    moq_media_type_t media_type;
    moq_bytes_t codec;
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
    if (buf_reserve(b, b->len + len) != 0) {
        return -1;
    }
    memcpy(b->data + b->len, src, len);
    b->len += len;
    return 0;
}

static void buf_clear(byte_buf_t *b)
{
    b->len = 0;
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

static int read_box_header(int fd, uint32_t *size_out, char type_out[5])
{
    uint8_t hdr[8];
    if (read_exact(fd, hdr, 8) != 0) {
        return -1;
    }
    uint32_t size = ((uint32_t)hdr[0] << 24) | ((uint32_t)hdr[1] << 16) |
                    ((uint32_t)hdr[2] << 8) | (uint32_t)hdr[3];
    memcpy(type_out, hdr + 4, 4);
    type_out[4] = '\0';

    if (size == 1) {
        uint8_t ext[8];
        if (read_exact(fd, ext, 8) != 0) {
            return -1;
        }
        size = (uint32_t)(((uint64_t)ext[0] << 56) | ((uint64_t)ext[1] << 48) |
                          ((uint64_t)ext[2] << 40) | ((uint64_t)ext[3] << 32) |
                          ((uint64_t)ext[4] << 24) | ((uint64_t)ext[5] << 16) |
                          ((uint64_t)ext[6] << 8) | (uint64_t)ext[7]);
        if (size < 16) {
            return -1;
        }
        *size_out = size - 16;
    } else if (size == 0) {
        return -1;
    } else if (size < 8) {
        return -1;
    } else {
        *size_out = size - 8;
    }
    return 0;
}

static int read_box_body(int fd, uint32_t body_len, byte_buf_t *out)
{
    if (body_len == 0) {
        return 0;
    }
    byte_buf_t tmp = {0};
    if (buf_reserve(&tmp, body_len) != 0) {
        return -1;
    }
    tmp.len = body_len;
    if (read_exact(fd, tmp.data, body_len) != 0) {
        buf_free(&tmp);
        return -1;
    }
    if (buf_append(out, tmp.data, tmp.len) != 0) {
        buf_free(&tmp);
        return -1;
    }
    buf_free(&tmp);
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

static void payload_release(void *ctx, const uint8_t *data, size_t len)
{
    (void)ctx;
    (void)data;
    (void)len;
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

static const char *track_name_for_kind(moq_cmaf_codec_kind_t kind, size_t ordinal)
{
    (void)ordinal;
    if (kind == MOQ_CMAF_CODEC_AAC || kind == MOQ_CMAF_CODEC_OPUS) {
        return "soun_2";
    }
    return "vide_1";
}

static int discover_tracks(app_ctx_t *ctx)
{
    if (ctx->init.len == 0) {
        return -1;
    }

    moq_cmaf_init_info_t info;
    moq_cmaf_init_info_init(&info);
    moq_bytes_t init = {ctx->init.data, ctx->init.len};
    if (moq_cmaf_parse_init(init, &info) != MOQ_OK) {
        fprintf(stderr, "failed to parse CMAF init segment (%zu bytes)\n", ctx->init.len);
        return -1;
    }

    track_slot_t *slot = &ctx->tracks[ctx->track_count++];
    memset(slot, 0, sizeof(*slot));
    slot->track_id = info.track_id ? info.track_id : 1;
    slot->media_type = (info.codec_kind == MOQ_CMAF_CODEC_AAC || info.codec_kind == MOQ_CMAF_CODEC_OPUS)
                           ? MOQ_MEDIA_TYPE_AUDIO
                           : MOQ_MEDIA_TYPE_VIDEO;
    strncpy(slot->name, track_name_for_kind(info.codec_kind, 0), sizeof(slot->name) - 1);

    if (info.codec_kind == MOQ_CMAF_CODEC_AVC) {
        slot->codec = (moq_bytes_t){(const uint8_t *)"avc1.42e01e", 11};
    } else if (info.codec_kind == MOQ_CMAF_CODEC_AAC) {
        slot->codec = (moq_bytes_t){(const uint8_t *)"mp4a.40.2", 9};
    } else {
        slot->codec = (moq_bytes_t){(const uint8_t *)"unknown", 7};
    }

    ctx->init_ready = true;
    return 0;
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
        moq_media_track_cfg_init(&tc);
        tc.name.data = (const uint8_t *)slot->name;
        tc.name.len = strlen(slot->name);
        tc.media_type = slot->media_type;
        tc.packaging = MOQ_MEDIA_PACKAGING_CMAF;
        tc.codec = slot->codec;
        tc.init_data.data = ctx->init.data;
        tc.init_data.len = ctx->init.len;
        tc.is_live = true;
        tc.bitrate = slot->media_type == MOQ_MEDIA_TYPE_AUDIO ? 128000 : 2500000;

        moq_result_t rc = moq_media_sender_add_track(tx, &tc, &slot->handle);
        if (rc != MOQ_OK) {
            fprintf(stderr, "add_track(%s) failed: %d\n", slot->name, (int)rc);
            return -1;
        }
        slot->added = true;
        fprintf(stderr, "track added: %s (id=%u)\n", slot->name, slot->track_id);
    }
    ctx->sender_ready = true;
    return 0;
}

static int publish_fragment(moq_media_sender_t *tx, app_ctx_t *ctx, const uint8_t *fragment,
                            size_t fragment_len)
{
    moq_cmaf_fragment_info_t finfo;
    moq_cmaf_sample_t samples[64];
    moq_cmaf_fragment_info_init(&finfo, samples, 64);

    moq_bytes_t frag_bytes = {fragment, fragment_len};
    moq_result_t pr = moq_cmaf_parse_fragment(frag_bytes, &finfo);
    if (pr == MOQ_ERR_BUFFER) {
        fprintf(stderr, "fragment sample table too large; skipping\n");
        return 0;
    }
    if (pr != MOQ_OK) {
        fprintf(stderr, "fragment parse failed\n");
        return 0;
    }

    uint32_t track_id = finfo.track_id ? finfo.track_id : 1;
    track_slot_t *slot = track_for_id(ctx, track_id);
    if (!slot || !slot->handle) {
        return 0;
    }

    byte_buf_t payload = {0};
    if (buf_append(&payload, fragment, fragment_len) != 0) {
        return -1;
    }

    moq_rcbuf_t *payload_rc = NULL;
    if (moq_rcbuf_wrap(moq_alloc_default(), payload.data, payload.len, payload_release, NULL,
                       &payload_rc) != MOQ_OK) {
        buf_free(&payload);
        return -1;
    }
    buf_free(&payload);

    bool keyframe = false;
    if (finfo.sample_count > 0) {
        keyframe = (finfo.samples[0].flags & 0x00010000u) == 0;
    }

    moq_cmaf_object_report_t report;
    moq_cmaf_object_report_init(&report);
    moq_cmaf_init_info_t init_info;
    moq_cmaf_init_info_init(&init_info);
    moq_cmaf_parse_init((moq_bytes_t){ctx->init.data, ctx->init.len}, &init_info);
    moq_cmaf_validate_object(&init_info, frag_bytes, &report);

    moq_media_send_object_t obj;
    memset(&obj, 0, sizeof(obj));
    obj.struct_size = sizeof(obj);
    obj.payload = payload_rc;
    obj.is_sync = keyframe || report.starts_with_sync;
    obj.starts_group = keyframe || report.starts_with_sync;
    if (report.valid && report.sap_type != MOQ_SAP_UNKNOWN) {
        obj.has_sap_type = true;
        obj.sap_type = report.sap_type;
    }

    moq_result_t wr = moq_media_sender_write(tx, slot->handle, &obj);
    if (wr == MOQ_ERR_WOULD_BLOCK) {
        moq_rcbuf_decref(payload_rc);
        usleep(2000);
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

        uint32_t body_len = 0;
        char type[5] = {0};
        if (read_box_header(STDIN_FILENO, &body_len, type) != 0) {
            break;
        }

        uint8_t hdr[8];
        memcpy(hdr + 4, type, 4);
        uint32_t total = body_len + 8;
        hdr[0] = (uint8_t)((total >> 24) & 0xff);
        hdr[1] = (uint8_t)((total >> 16) & 0xff);
        hdr[2] = (uint8_t)((total >> 8) & 0xff);
        hdr[3] = (uint8_t)(total & 0xff);

        if (strcmp(type, "ftyp") == 0 || strcmp(type, "moov") == 0) {
            if (buf_append(&ctx->init, hdr, 8) != 0) {
                return -1;
            }
            if (read_box_body(STDIN_FILENO, body_len, &ctx->init) != 0) {
                return -1;
            }
            if (strcmp(type, "moov") == 0 && !ctx->init_ready) {
                if (discover_tracks(ctx) != 0) {
                    return -1;
                }
                if (ensure_tracks_added(tx, ctx) != 0) {
                    return -1;
                }
            }
            continue;
        }

        if (strcmp(type, "moof") == 0) {
            byte_buf_t moof = {0};
            if (buf_append(&moof, hdr, 8) != 0) {
                return -1;
            }
            if (read_box_body(STDIN_FILENO, body_len, &moof) != 0) {
                buf_free(&moof);
                return -1;
            }

            uint32_t mdat_len = 0;
            char mdat_type[5] = {0};
            if (read_box_header(STDIN_FILENO, &mdat_len, mdat_type) != 0 ||
                strcmp(mdat_type, "mdat") != 0) {
                buf_free(&moof);
                fprintf(stderr, "expected mdat after moof, got %s\n", mdat_type);
                return -1;
            }

            byte_buf_t mdat = {0};
            uint8_t mdat_hdr[8];
            uint32_t mdat_total = mdat_len + 8;
            mdat_hdr[0] = (uint8_t)((mdat_total >> 24) & 0xff);
            mdat_hdr[1] = (uint8_t)((mdat_total >> 16) & 0xff);
            mdat_hdr[2] = (uint8_t)((mdat_total >> 8) & 0xff);
            mdat_hdr[3] = (uint8_t)(mdat_total & 0xff);
            memcpy(mdat_hdr + 4, "mdat", 4);
            if (buf_append(&mdat, mdat_hdr, 8) != 0 ||
                read_box_body(STDIN_FILENO, mdat_len, &mdat) != 0) {
                buf_free(&moof);
                buf_free(&mdat);
                return -1;
            }

            if (!ctx->sender_ready) {
                if (ctx->init.len > 0 && !ctx->init_ready) {
                    discover_tracks(ctx);
                    ensure_tracks_added(tx, ctx);
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

        /* Skip unknown boxes */
        byte_buf_t skip = {0};
        if (read_box_body(STDIN_FILENO, body_len, &skip) != 0) {
            buf_free(&skip);
            return -1;
        }
        buf_free(&skip);
    }
    return 0;
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
    moq_media_sender_cfg_init_live(&scfg);
    scfg.endpoint = NULL;
    scfg.namespace_.parts = ns_parts;
    scfg.namespace_.count = ns_count;

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
    buf_free(&ctx.init);

    return ingest_rc == 0 ? 0 : 1;
}
