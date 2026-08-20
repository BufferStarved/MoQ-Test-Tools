/*
 * moq5-fmp4-publish — read fragmented MP4 from stdin, publish via libmoq.
 *
 * Intended pipeline:
 *   ffmpeg ... -movflags \
 *     +frag_keyframe+empty_moov+default_base_moof+separate_moof \
 *     -f mp4 pipe:1 | moq5-fmp4-publish <url> <namespace>
 *
 * Usage:
 *   moq5-fmp4-publish <url> <namespace> [--insecure-skip-verify] [--duration SEC]
 *                                      [--qlog-dir PATH]
 */

#include "fmp4_moq_bridge.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void on_signal(int sig)
{
    (void)sig;
    fmp4_moq_request_stop();
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

    uint8_t chunk[65536];
    int rc = 0;
    while (!fmp4_moq_should_stop(bridge)) {
        ssize_t n = read(STDIN_FILENO, chunk, sizeof(chunk));
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
    }

    if (fmp4_moq_close(bridge) != 0) {
        rc = -1;
    }
    return rc == 0 ? 0 : 1;
}
