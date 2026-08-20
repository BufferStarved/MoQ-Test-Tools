/*
 * ffmoq — native libavformat → OpenMOQ moq5 (libmoq) publisher.
 *
 * Remuxes input to fragmented MP4 through a custom AVIO that calls
 * fmp4_moq_feed(). Same CMAF contract as `ffmpeg -f mp4 pipe:1 | moq5-fmp4-publish`.
 *
 *   ffmoq <url> <namespace> <input> [--insecure-skip-verify] [--duration SEC]
 *         [--qlog-dir PATH]
 *
 * One process: libavformat mux + libmoq WebTransport. The in-tree ffmpeg
 * protocol (libavformat/libmoq.c) is the same write path inside ffmpeg itself.
 */

#include "fmp4_moq_bridge.h"

#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/mem.h>

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define AVIO_BUF_SIZE 65536
#define MOVFLAGS \
    "frag_keyframe+empty_moov+default_base_moof+separate_moof"

static void on_signal(int sig)
{
    (void)sig;
    fmp4_moq_request_stop();
}

static int moq_avio_write(void *opaque, const uint8_t *buf, int buf_size)
{
    fmp4_moq_bridge_t *bridge = opaque;
    if (buf_size <= 0) {
        return buf_size;
    }
    if (fmp4_moq_should_stop(bridge)) {
        return AVERROR_EXIT;
    }
    if (fmp4_moq_feed(bridge, buf, (size_t)buf_size) != 0) {
        return AVERROR(EIO);
    }
    return buf_size;
}

int main(int argc, char **argv)
{
    if (argc < 4) {
        fprintf(stderr,
                "usage: %s <url> <namespace> <input> [--insecure-skip-verify] "
                "[--duration SEC] [--qlog-dir PATH]\n",
                argv[0]);
        return 2;
    }

    const char *url = argv[1];
    const char *namespace_ = argv[2];
    const char *input = argv[3];
    fmp4_moq_opts_t opts;
    memset(&opts, 0, sizeof(opts));

    for (int i = 4; i < argc; i++) {
        if (strcmp(argv[i], "--insecure-skip-verify") == 0) {
            opts.insecure_skip_verify = 1;
        } else if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) {
            opts.duration_sec = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--qlog-dir") == 0 && i + 1 < argc) {
            opts.qlog_dir = argv[++i];
        }
    }

    signal(SIGINT, on_signal);
    signal(SIGPIPE, SIG_IGN);

    fmp4_moq_bridge_t *bridge = fmp4_moq_connect(url, namespace_, &opts);
    if (!bridge) {
        return 1;
    }
    fprintf(stderr, "ffmoq: url=%s namespace=%s input=%s\n", url, namespace_, input);

    AVFormatContext *in_ctx = NULL;
    AVFormatContext *out_ctx = NULL;
    AVIOContext *avio = NULL;
    unsigned char *avio_buf = NULL;
    AVPacket *pkt = NULL;
    int rc = 1;
    int av_err = 0;

    av_err = avformat_open_input(&in_ctx, input, NULL, NULL);
    if (av_err < 0) {
        fprintf(stderr, "ffmoq: open input: %s\n", av_err2str(av_err));
        goto done;
    }
    av_err = avformat_find_stream_info(in_ctx, NULL);
    if (av_err < 0) {
        fprintf(stderr, "ffmoq: stream info: %s\n", av_err2str(av_err));
        goto done;
    }

    av_err = avformat_alloc_output_context2(&out_ctx, NULL, "mp4", NULL);
    if (av_err < 0 || !out_ctx) {
        fprintf(stderr, "ffmoq: alloc mp4 muxer failed\n");
        goto done;
    }
    unsigned stream_map[8];
    unsigned nmap = 0;
    for (unsigned i = 0; i < in_ctx->nb_streams && nmap < 8; i++) {
        enum AVMediaType t = in_ctx->streams[i]->codecpar->codec_type;
        if (t != AVMEDIA_TYPE_VIDEO && t != AVMEDIA_TYPE_AUDIO) {
            continue;
        }
        AVStream *out_st = avformat_new_stream(out_ctx, NULL);
        if (!out_st) {
            av_err = AVERROR(ENOMEM);
            goto done;
        }
        av_err = avcodec_parameters_copy(out_st->codecpar, in_ctx->streams[i]->codecpar);
        if (av_err < 0) {
            goto done;
        }
        out_st->codecpar->codec_tag = 0;
        out_st->time_base = in_ctx->streams[i]->time_base;
        stream_map[nmap++] = i;
    }
    if (nmap == 0) {
        fprintf(stderr, "ffmoq: input has no video or audio streams\n");
        goto done;
    }

    avio_buf = av_malloc(AVIO_BUF_SIZE);
    if (!avio_buf) {
        goto done;
    }
    avio = avio_alloc_context(avio_buf, AVIO_BUF_SIZE, 1, bridge, NULL, moq_avio_write, NULL);
    if (!avio) {
        av_freep(&avio_buf);
        goto done;
    }
    avio_buf = NULL; /* owned by avio */
    out_ctx->pb = avio;
    out_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;
    out_ctx->url = av_strdup("moq:output");

    AVDictionary *mux_opts = NULL;
    av_dict_set(&mux_opts, "movflags", MOVFLAGS, 0);
    av_err = avformat_write_header(out_ctx, &mux_opts);
    av_dict_free(&mux_opts);
    if (av_err < 0) {
        fprintf(stderr, "ffmoq: write_header: %s\n", av_err2str(av_err));
        goto done;
    }

    pkt = av_packet_alloc();
    if (!pkt) {
        goto done;
    }

    int64_t max_ts = opts.duration_sec > 0
        ? (int64_t)opts.duration_sec * AV_TIME_BASE
        : 0;
    while (!fmp4_moq_should_stop(bridge)) {
        av_err = av_read_frame(in_ctx, pkt);
        if (av_err == AVERROR_EOF) {
            break;
        }
        if (av_err < 0) {
            fprintf(stderr, "ffmoq: read: %s\n", av_err2str(av_err));
            goto done;
        }
        unsigned in_index = (unsigned)pkt->stream_index;
        int out_index = -1;
        for (unsigned m = 0; m < nmap; m++) {
            if (stream_map[m] == in_index) {
                out_index = (int)m;
                break;
            }
        }
        if (out_index < 0) {
            av_packet_unref(pkt);
            continue;
        }
        AVStream *in_st = in_ctx->streams[in_index];
        AVStream *out_st = out_ctx->streams[out_index];
        if (max_ts > 0 && pkt->pts != AV_NOPTS_VALUE) {
            int64_t ts = av_rescale_q(pkt->pts, in_st->time_base, AV_TIME_BASE_Q);
            if (ts >= max_ts) {
                av_packet_unref(pkt);
                break;
            }
        }
        av_packet_rescale_ts(pkt, in_st->time_base, out_st->time_base);
        pkt->stream_index = out_index;
        pkt->pos = -1;
        av_err = av_interleaved_write_frame(out_ctx, pkt);
        av_packet_unref(pkt);
        if (av_err < 0) {
            fprintf(stderr, "ffmoq: write_frame: %s\n", av_err2str(av_err));
            goto done;
        }
    }

    av_err = av_write_trailer(out_ctx);
    if (av_err < 0) {
        fprintf(stderr, "ffmoq: trailer: %s\n", av_err2str(av_err));
        goto done;
    }
    rc = 0;
    fprintf(stderr, "ffmoq: published\n");

done:
    av_packet_free(&pkt);
    if (out_ctx) {
        if (out_ctx->pb) {
            avio_context_free(&out_ctx->pb);
        }
        avformat_free_context(out_ctx);
    }
    avformat_close_input(&in_ctx);
    if (fmp4_moq_close(bridge) != 0 && rc == 0) {
        rc = 1;
    }
    return rc;
}
