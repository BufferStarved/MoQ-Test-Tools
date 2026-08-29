/*
 * moq5-fmp4-publish — read fragmented MP4 from stdin, publish via libmoq.
 *
 * Intended pipeline:
 *   ffmpeg ... -movflags \
 *     +frag_keyframe+empty_moov+default_base_moof+separate_moof \
 *     -f mp4 pipe:1 | moq5-fmp4-publish <url> <namespace>
 *
 * CONNECT starts immediately so the handshake overlaps remux probe.
 * Sender attach still waits until moov so the first live catalog has
 * vide/soun. Handshake must not stop reading stdin: a realtime webcam
 * fill of the ~64KiB OS pipe becomes EIO/SIGPIPE (bench-43cf3725).
 * A dedicated reader thread drains stdin into a 16MiB queue.
 *
 * Usage:
 *   moq5-fmp4-publish <url> <namespace> [--insecure-skip-verify] [--duration SEC]
 *                                      [--qlog-dir PATH]
 */

#include "fmp4_moq_bridge.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define STDIN_Q_CAP (16u * 1024u * 1024u)

typedef struct {
    uint8_t *buf;
    size_t cap;
    size_t r;
    size_t w;
    size_t len;
    int eof;
    int err;
    pthread_mutex_t mu;
    pthread_cond_t can_read;
    pthread_cond_t can_write;
} stdin_q_t;

static void on_signal(int sig)
{
    (void)sig;
    fmp4_moq_request_stop();
}

static int stdin_q_init(stdin_q_t *q)
{
    memset(q, 0, sizeof(*q));
    q->buf = malloc(STDIN_Q_CAP);
    if (!q->buf) {
        return -1;
    }
    q->cap = STDIN_Q_CAP;
    pthread_mutex_init(&q->mu, NULL);
    pthread_cond_init(&q->can_read, NULL);
    pthread_cond_init(&q->can_write, NULL);
    return 0;
}

static void stdin_q_close(stdin_q_t *q)
{
    pthread_mutex_lock(&q->mu);
    q->eof = 1;
    pthread_cond_broadcast(&q->can_read);
    pthread_cond_broadcast(&q->can_write);
    pthread_mutex_unlock(&q->mu);
}

static void stdin_q_destroy(stdin_q_t *q)
{
    pthread_cond_destroy(&q->can_read);
    pthread_cond_destroy(&q->can_write);
    pthread_mutex_destroy(&q->mu);
    free(q->buf);
    q->buf = NULL;
}

static void *stdin_reader_main(void *arg)
{
    stdin_q_t *q = arg;
    uint8_t tmp[65536];
    for (;;) {
        ssize_t n = read(STDIN_FILENO, tmp, sizeof(tmp));
        if (n == 0) {
            stdin_q_close(q);
            return NULL;
        }
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            pthread_mutex_lock(&q->mu);
            q->err = errno;
            q->eof = 1;
            pthread_cond_broadcast(&q->can_read);
            pthread_cond_broadcast(&q->can_write);
            pthread_mutex_unlock(&q->mu);
            return NULL;
        }
        size_t off = 0;
        while (off < (size_t)n) {
            pthread_mutex_lock(&q->mu);
            while (q->len == q->cap && !q->eof) {
                pthread_cond_wait(&q->can_write, &q->mu);
            }
            if (q->eof) {
                pthread_mutex_unlock(&q->mu);
                return NULL;
            }
            size_t space = q->cap - q->len;
            size_t chunk = (size_t)n - off;
            if (chunk > space) {
                chunk = space;
            }
            size_t first = q->cap - q->w;
            if (first > chunk) {
                first = chunk;
            }
            memcpy(q->buf + q->w, tmp + off, first);
            if (chunk > first) {
                memcpy(q->buf, tmp + off + first, chunk - first);
            }
            q->w = (q->w + chunk) % q->cap;
            q->len += chunk;
            off += chunk;
            pthread_cond_signal(&q->can_read);
            pthread_mutex_unlock(&q->mu);
        }
    }
}

static void stdin_q_fill(stdin_q_t *q, size_t *len, size_t *cap, size_t *high)
{
    pthread_mutex_lock(&q->mu);
    if (len) {
        *len = q->len;
    }
    if (cap) {
        *cap = q->cap;
    }
    if (high && q->len > *high) {
        *high = q->len;
    }
    pthread_mutex_unlock(&q->mu);
}

static ssize_t stdin_q_read(stdin_q_t *q, uint8_t *dst, size_t max)
{
    pthread_mutex_lock(&q->mu);
    while (q->len == 0 && !q->eof) {
        pthread_cond_wait(&q->can_read, &q->mu);
    }
    if (q->len == 0) {
        int err = q->err;
        pthread_mutex_unlock(&q->mu);
        if (err) {
            errno = err;
            return -1;
        }
        return 0;
    }
    size_t take = q->len < max ? q->len : max;
    size_t first = q->cap - q->r;
    if (first > take) {
        first = take;
    }
    memcpy(dst, q->buf + q->r, first);
    if (take > first) {
        memcpy(dst + first, q->buf, take - first);
    }
    q->r = (q->r + take) % q->cap;
    q->len -= take;
    pthread_cond_signal(&q->can_write);
    pthread_mutex_unlock(&q->mu);
    return (ssize_t)take;
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
    const char *namespace_ = argv[2];
    fmp4_moq_opts_t opts;
    memset(&opts, 0, sizeof(opts));

    for (int i = 3; i < argc; i++) {
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

    fprintf(stderr, "moq5-fmp4-publish: url=%s namespace=%s\n", url, namespace_);

    stdin_q_t queue;
    if (stdin_q_init(&queue) != 0) {
        fprintf(stderr, "stdin queue alloc failed\n");
        fmp4_moq_close(bridge);
        return 1;
    }

    pthread_t reader;
    if (pthread_create(&reader, NULL, stdin_reader_main, &queue) != 0) {
        fprintf(stderr, "stdin reader thread failed\n");
        stdin_q_destroy(&queue);
        fmp4_moq_close(bridge);
        return 1;
    }

    uint8_t chunk[65536];
    int rc = 0;
    size_t q_high = 0;
    struct timespec next_qlog;
    clock_gettime(CLOCK_MONOTONIC, &next_qlog);
    next_qlog.tv_sec += 1;
    fprintf(stderr, "pub_stats: stdin_q every 1s; pub track= when write >=20ms\n");
    while (!fmp4_moq_should_stop(bridge)) {
        ssize_t n = stdin_q_read(&queue, chunk, sizeof(chunk));
        if (n == 0) {
            break;
        }
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            rc = -1;
            break;
        }
        if (fmp4_moq_feed(bridge, chunk, (size_t)n) != 0) {
            rc = -1;
            break;
        }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > next_qlog.tv_sec ||
            (now.tv_sec == next_qlog.tv_sec && now.tv_nsec >= next_qlog.tv_nsec)) {
            size_t qlen = 0;
            size_t qcap = 0;
            stdin_q_fill(&queue, &qlen, &qcap, &q_high);
            double fill_mib = qlen / (1024.0 * 1024.0);
            double cap_mib = qcap / (1024.0 * 1024.0);
            double high_mib = q_high / (1024.0 * 1024.0);
            int pct = qcap ? (int)((qlen * 100) / qcap) : 0;
            fprintf(stderr, "stdin_q fill=%.2f/%.1fMiB (%d%%) high=%.2fMiB\n",
                    fill_mib, cap_mib, pct, high_mib);
            next_qlog = now;
            next_qlog.tv_sec += 1;
        }
    }

    stdin_q_close(&queue);
    pthread_join(reader, NULL);
    stdin_q_destroy(&queue);

    if (fmp4_moq_close(bridge) != 0) {
        rc = -1;
    }
    return rc == 0 ? 0 : 1;
}
