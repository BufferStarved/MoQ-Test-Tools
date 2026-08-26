/*
 * moq_link_spike — prove a native program can link fmp4_moq + moq::service
 * and publish an existing multitrack fMP4 fixture.
 *
 *   moq_link_spike <url> <namespace> [fixture.mp4] [--insecure-skip-verify]
 */

#include "fmp4_moq_bridge.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int load_file(const char *path, uint8_t **out, size_t *out_len)
{
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        fprintf(stderr, "failed to open fixture %s: %s\n", path, strerror(errno));
        return -1;
    }
    if (fseek(fp, 0, SEEK_END) != 0) {
        fclose(fp);
        return -1;
    }
    long size = ftell(fp);
    if (size <= 0 || fseek(fp, 0, SEEK_SET) != 0) {
        fclose(fp);
        return -1;
    }
    uint8_t *buf = malloc((size_t)size);
    if (!buf) {
        fclose(fp);
        return -1;
    }
    size_t got = fread(buf, 1, (size_t)size, fp);
    fclose(fp);
    if (got != (size_t)size) {
        free(buf);
        return -1;
    }
    *out = buf;
    *out_len = got;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr,
                "usage: %s <url> <namespace> [fixture.mp4] [--insecure-skip-verify]\n",
                argv[0]);
        return 2;
    }

    const char *url = argv[1];
    const char *namespace_ = argv[2];
    const char *fixture = "moq5-multitrack-fixture.mp4";
    fmp4_moq_opts_t opts;
    memset(&opts, 0, sizeof(opts));

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--insecure-skip-verify") == 0) {
            opts.insecure_skip_verify = 1;
        } else if (argv[i][0] != '-') {
            fixture = argv[i];
        }
    }

    uint8_t *data = NULL;
    size_t len = 0;
    if (load_file(fixture, &data, &len) != 0) {
        return 2;
    }

    fprintf(stderr, "moq_link_spike: url=%s namespace=%s fixture=%s (%zu bytes)\n",
            url, namespace_, fixture, len);

    fmp4_moq_bridge_t *bridge = fmp4_moq_connect(url, namespace_, &opts);
    if (!bridge) {
        free(data);
        return 1;
    }

    /* Feed in small chunks so partial-box assembly is exercised. */
    const size_t chunk = 4096;
    int rc = 0;
    for (size_t off = 0; off < len; off += chunk) {
        size_t n = len - off < chunk ? len - off : chunk;
        if (fmp4_moq_feed(bridge, data + off, n) != 0) {
            rc = -1;
            break;
        }
    }
    free(data);

    if (fmp4_moq_close(bridge) != 0) {
        rc = -1;
    }
    if (rc != 0) {
        return 1;
    }
    fprintf(stderr, "moq_link_spike: published fixture\n");
    return 0;
}
