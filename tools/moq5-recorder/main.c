/*
 * moq5-fmp4-record — subscribe to a MoQ namespace and write received CMAF fMP4
 * to a file (for relay-side ingest VMAF).
 *
 * Usage:
 *   moq5-fmp4-record <url> <namespace> <output.mp4>
 *       [--insecure-skip-verify] [--duration SEC]
 */

#include <moq/endpoint.h>
#include <moq/media_receiver.h>
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

enum { ENDPOINT_DRAIN_TIMEOUT_US = 5000000 };

typedef struct {
    FILE *out;
    bool init_written;
    moq_media_track_t *video_track;
} app_ctx_t;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
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

static bool track_name_is_video(const moq_media_track_desc_t *desc)
{
    if (!desc) {
        return false;
    }
    if (desc->info.media_type == MOQ_MEDIA_TYPE_VIDEO) {
        return true;
    }
    if (desc->name.len >= 4 && desc->name.data &&
        memcmp(desc->name.data, "vide", 4) == 0) {
        return true;
    }
    return false;
}

static int write_init_segment(app_ctx_t *ctx, const moq_media_track_desc_t *desc)
{
    if (ctx->init_written || !desc || !desc->has_init || desc->init_data.len == 0) {
        return 0;
    }
    if (!track_name_is_video(desc)) {
        return 0;
    }

    size_t written = fwrite(desc->init_data.data, 1, desc->init_data.len, ctx->out);
    if (written != desc->init_data.len) {
        fprintf(stderr, "failed to write init segment (%zu bytes)\n", desc->init_data.len);
        return -1;
    }
    fflush(ctx->out);
    ctx->init_written = true;
    fprintf(stderr, "wrote init segment (%zu bytes)\n", desc->init_data.len);
    return 0;
}

static int write_fragment(app_ctx_t *ctx, const moq_media_object_t *obj)
{
    if (!ctx->init_written) {
        return 0;
    }
    if (obj->packaging != MOQ_MEDIA_PACKAGING_CMAF || obj->fragment.len == 0) {
        return 0;
    }
    if (ctx->video_track != NULL && obj->track != ctx->video_track) {
        return 0;
    }

    size_t written = fwrite(obj->fragment.data, 1, obj->fragment.len, ctx->out);
    if (written != obj->fragment.len) {
        fprintf(stderr, "failed to write fragment (%zu bytes)\n", obj->fragment.len);
        return -1;
    }
    fflush(ctx->out);
    return 0;
}

static void drain_before_stop(moq_endpoint_t *ep)
{
    moq_result_t dr = moq_endpoint_drain(ep, ENDPOINT_DRAIN_TIMEOUT_US);
    if (dr == MOQ_DONE) {
        fprintf(stderr, "endpoint drain timed out; stopping anyway\n");
    }
}

static int record_loop(moq_media_receiver_t *rx, moq_endpoint_t *ep, app_ctx_t *ctx,
                       int duration_sec)
{
    time_t deadline = duration_sec > 0 ? time(NULL) + duration_sec : 0;
    uint64_t fragments = 0;

    while (!g_stop) {
        if (deadline > 0 && time(NULL) >= deadline) {
            break;
        }

        moq_result_t wr = moq_media_receiver_wait(rx, 200000);
        if (wr == MOQ_ERR_CLOSED) {
            break;
        }

        moq_media_track_event_t ev;
        while (moq_media_receiver_poll_track(rx, &ev, sizeof(ev)) == MOQ_OK) {
            if (ev.kind == MOQ_MEDIA_TRACK_ADDED && ev.desc) {
                if (track_name_is_video(ev.desc) && ctx->video_track == NULL) {
                    ctx->video_track = ev.track;
                }
                if (write_init_segment(ctx, ev.desc) != 0) {
                    return -1;
                }
            }
        }

        moq_media_object_t obj;
        while (moq_media_receiver_poll_object(rx, &obj, sizeof(obj)) == MOQ_OK) {
            if (write_fragment(ctx, &obj) != 0) {
                moq_media_object_cleanup(&obj);
                return -1;
            }
            fragments++;
            moq_media_object_cleanup(&obj);
        }

        if (moq_media_receiver_is_fatal(rx)) {
            fprintf(stderr, "receiver fatal code=%llu\n",
                    (unsigned long long)moq_media_receiver_fatal_code(rx));
            return -1;
        }
        if (moq_media_receiver_is_closed(rx)) {
            break;
        }
    }

    fprintf(stderr, "recorded %llu fragments\n", (unsigned long long)fragments);
    (void)ep;
    return ctx->init_written && fragments > 0 ? 0 : 1;
}

int main(int argc, char **argv)
{
    if (argc < 4) {
        fprintf(stderr,
                "usage: %s <url> <namespace> <output.mp4> [--insecure-skip-verify] "
                "[--duration SEC]\n",
                argv[0]);
        return 2;
    }

    const char *url = argv[1];
    char nsbuf[256];
    snprintf(nsbuf, sizeof(nsbuf), "%s", argv[2]);
    const char *output_path = argv[3];
    bool insecure = false;
    int duration_sec = 0;

    for (int i = 4; i < argc; i++) {
        if (strcmp(argv[i], "--insecure-skip-verify") == 0) {
            insecure = true;
        } else if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) {
            duration_sec = atoi(argv[++i]);
        }
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    FILE *out = fopen(output_path, "wb");
    if (!out) {
        fprintf(stderr, "could not open %s: %s\n", output_path, strerror(errno));
        return 1;
    }

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
        fclose(out);
        return 1;
    }

    moq_media_receiver_cfg_t cfg;
    moq_media_receiver_cfg_init_flow_control(&cfg);
    cfg.endpoint = NULL;
    cfg.namespace_.parts = ns_parts;
    cfg.namespace_.count = ns_count;
    cfg.auto_subscribe = true;

    moq_media_receiver_t *rx = NULL;
    rc = moq_media_receiver_attach(ep, &cfg, &rx);
    if (rc != MOQ_OK) {
        fprintf(stderr, "receiver attach failed: %d\n", (int)rc);
        moq_endpoint_stop(ep);
        moq_endpoint_destroy(ep);
        fclose(out);
        return 1;
    }

    app_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.out = out;

    fprintf(stderr, "moq5-fmp4-record: url=%s namespace=%s output=%s\n", url, nsbuf,
            output_path);
    int record_rc = record_loop(rx, ep, &ctx, duration_sec);

    moq_media_receiver_destroy(rx);
    drain_before_stop(ep);
    moq_endpoint_stop(ep);
    moq_endpoint_destroy(ep);
    fclose(out);

    return record_rc;
}
