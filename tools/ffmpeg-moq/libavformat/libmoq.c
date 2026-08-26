/*
 * OpenMOQ moq5 (libmoq) protocol for ffmpeg 8.
 *
 * Drop this file into FFmpeg's libavformat/ and enable with
 *   ./configure --enable-libmoq ...
 * See scripts/build-ffmpeg-libmoq.sh.
 *
 * Write-only. Same CMAF contract as ffmoq / moq5-fmp4-publish:
 *
 *   ffmpeg ... -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof \
 *     -f mp4 'moq://HOST:14433/moq-relay?namespace=bench-d18'
 *
 * Query: namespace (required), insecure=1, qlog=/path
 */

#include "fmp4_moq_bridge.h"

#include "libavutil/avstring.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "avformat.h"
#include "internal.h"
#include "url.h"

typedef struct MoqContext {
    const AVClass *class;
    fmp4_moq_bridge_t *bridge;
    char *namespace;
    int insecure;
    char *qlog_dir;
} MoqContext;

static int moq_open(URLContext *h, const char *uri, int flags)
{
    MoqContext *c = h->priv_data;
    char proto[16], auth[256], hostname[1024], path[MAX_URL_SIZE];
    char https_url[MAX_URL_SIZE];
    int port = -1;
    const char *query;
    fmp4_moq_opts_t opts;

    (void)flags;
    av_url_split(proto, sizeof(proto), auth, sizeof(auth),
                 hostname, sizeof(hostname), &port,
                 path, sizeof(path), uri);

    if (!hostname[0]) {
        av_log(h, AV_LOG_ERROR, "moq: missing host\n");
        return AVERROR(EINVAL);
    }
    if (port <= 0) {
        port = 4433;
    }
    if (!path[0] || !strcmp(path, "/")) {
        av_strlcpy(path, "/moq-relay", sizeof(path));
    }

    query = strchr(uri, '?');
    if (query) {
        AVDictionary *kv = NULL;
        av_dict_parse_string(&kv, query + 1, "=", "&", 0);
        if (!c->namespace) {
            AVDictionaryEntry *e = av_dict_get(kv, "namespace", NULL, 0);
            if (e) {
                c->namespace = av_strdup(e->value);
            }
        }
        AVDictionaryEntry *ins = av_dict_get(kv, "insecure", NULL, 0);
        if (ins && strcmp(ins->value, "0") != 0 && strcmp(ins->value, "false") != 0) {
            c->insecure = 1;
        }
        if (!c->qlog_dir) {
            AVDictionaryEntry *q = av_dict_get(kv, "qlog", NULL, 0);
            if (q) {
                c->qlog_dir = av_strdup(q->value);
            }
        }
        av_dict_free(&kv);
    }

    if (!c->namespace || !c->namespace[0]) {
        av_log(h, AV_LOG_ERROR, "moq: namespace is required (?namespace=...)\n");
        return AVERROR(EINVAL);
    }

    if (!c->insecure && av_stristr(hostname, "sslip.io")) {
        c->insecure = 1;
    }

    snprintf(https_url, sizeof(https_url), "https://%s:%d%s", hostname, port, path);

    memset(&opts, 0, sizeof(opts));
    opts.insecure_skip_verify = c->insecure;
    opts.qlog_dir = c->qlog_dir;
    c->bridge = fmp4_moq_connect(https_url, c->namespace, &opts);
    if (!c->bridge) {
        av_log(h, AV_LOG_ERROR, "moq: connect failed for %s ns=%s\n",
               https_url, c->namespace);
        return AVERROR(EIO);
    }
    h->is_streamed = 1;
    av_log(h, AV_LOG_INFO, "moq: connected %s namespace=%s\n", https_url, c->namespace);
    return 0;
}

static int moq_write(URLContext *h, const unsigned char *buf, int size)
{
    MoqContext *c = h->priv_data;
    if (size <= 0) {
        return size;
    }
    if (fmp4_moq_should_stop(c->bridge) || fmp4_moq_feed(c->bridge, buf, (size_t)size) != 0) {
        return AVERROR(EIO);
    }
    return size;
}

static int moq_close(URLContext *h)
{
    MoqContext *c = h->priv_data;
    int rc = 0;
    if (c->bridge) {
        if (fmp4_moq_close(c->bridge) != 0) {
            rc = AVERROR(EIO);
        }
        c->bridge = NULL;
    }
    return rc;
}

#define OFFSET(x) offsetof(MoqContext, x)
#define E AV_OPT_FLAG_ENCODING_PARAM
static const AVOption options[] = {
    { "namespace", "MoQ track namespace", OFFSET(namespace), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, E },
    { "insecure", "skip TLS verify", OFFSET(insecure), AV_OPT_TYPE_BOOL, { .i64 = 0 }, 0, 1, E },
    { "qlog", "picoquic qlog directory", OFFSET(qlog_dir), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, E },
    { NULL }
};

static const AVClass moq_context_class = {
    .class_name = "moq",
    .item_name  = av_default_item_name,
    .option     = options,
    .version    = LIBAVUTIL_VERSION_INT,
};

const URLProtocol ff_libmoq_protocol = {
    .name            = "moq",
    .url_open        = moq_open,
    .url_write       = moq_write,
    .url_close       = moq_close,
    .priv_data_size  = sizeof(MoqContext),
    .priv_data_class = &moq_context_class,
    .flags           = URL_PROTOCOL_FLAG_NETWORK,
};
