#include "fmp4_moq_bridge_priv.h"

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define CHECK(expr) do { \
    if (!(expr)) { \
        fprintf(stderr, "CHECK failed at %s:%d: %s\n", \
                __FILE__, __LINE__, #expr); \
        goto fail; \
    } \
} while (0)

static int load_file(const char *path, byte_buf_t *out)
{
    FILE *fp = fopen(path, "rb");
    if (!fp) return -1;
    if (fseek(fp, 0, SEEK_END) != 0) {
        fclose(fp);
        return -1;
    }
    long size = ftell(fp);
    if (size <= 0 || fseek(fp, 0, SEEK_SET) != 0 ||
        (uintmax_t)size > SIZE_MAX || buf_reserve(out, (size_t)size) != 0) {
        fclose(fp);
        return -1;
    }
    size_t got = fread(out->data, 1, (size_t)size, fp);
    fclose(fp);
    if (got != (size_t)size) return -1;
    out->len = got;
    return 0;
}

static int write_all(int fd, const uint8_t *data, size_t len)
{
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, data + off, len - off);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        off += (size_t)n;
    }
    return 0;
}

static int test_stream_box_reader(void)
{
    int result = -1;
    int fds[2] = {-1, -1};
    byte_buf_t body = {0};
    uint8_t encoded[20] = {0};
    write_be32(encoded, 1);
    memcpy(encoded + 4, "free", 4);
    write_be32(encoded + 8, 0);
    write_be32(encoded + 12, sizeof(encoded));
    encoded[16] = 0x11;
    encoded[17] = 0x22;
    encoded[18] = 0x33;
    encoded[19] = 0x44;

    CHECK(pipe(fds) == 0);
    CHECK(write_all(fds[1], encoded, sizeof(encoded)) == 0);
    CHECK(close(fds[1]) == 0);
    fds[1] = -1;

    stream_box_header_t box;
    CHECK(read_box_header(fds[0], &box) == 0);
    CHECK(box.header_size == 16);
    CHECK(box.body_size == 4);
    CHECK(strcmp(box.type, "free") == 0);
    CHECK(memcmp(box.bytes, encoded, 16) == 0);
    CHECK(read_box_body(fds[0], box.body_size, &body) == 0);
    CHECK(body.len == 4);
    CHECK(memcmp(body.data, encoded + 16, 4) == 0);
    CHECK(read_box_header(fds[0], &box) == 1);
    CHECK(close(fds[0]) == 0);
    fds[0] = -1;

    /* EOF after a partial header is malformed input, not a clean end. */
    CHECK(pipe(fds) == 0);
    CHECK(write_all(fds[1], encoded, 4) == 0);
    CHECK(close(fds[1]) == 0);
    fds[1] = -1;
    CHECK(read_box_header(fds[0], &box) == -1);
    result = 0;

fail:
    if (fds[0] >= 0) close(fds[0]);
    if (fds[1] >= 0) close(fds[1]);
    buf_free(&body);
    return result;
}

static int test_interleaved_fragment_rejected(const char *path,
                                              app_ctx_t *ctx)
{
    int result = -1;
    byte_buf_t file = {0};
    byte_buf_t fragment = {0};
    CHECK(load_file(path, &file) == 0);

    size_t pos = 0;
    bool checked = false;
    while (pos < file.len) {
        mp4_box_t moof;
        CHECK(mp4_box_at(file.data, file.len, pos, &moof) == 0);
        if (moof.type != MP4_TYPE('m', 'o', 'o', 'f')) {
            pos += moof.size;
            continue;
        }

        mp4_box_t mdat;
        CHECK(mp4_box_at(file.data, file.len, pos + moof.size, &mdat) == 0);
        CHECK(mdat.type == MP4_TYPE('m', 'd', 'a', 't'));
        CHECK(buf_append(&fragment, file.data + moof.offset, moof.size) == 0);
        CHECK(buf_append(&fragment, file.data + mdat.offset, mdat.size) == 0);

        moq_cmaf_sample_t samples[512];
        moq_cmaf_fragment_info_t finfo;
        moq_cmaf_fragment_info_init(&finfo, samples,
                                    sizeof(samples) / sizeof(samples[0]));
        moq_bytes_t bytes = {fragment.data, fragment.len};
        CHECK(moq_cmaf_parse_fragment(bytes, &finfo) == MOQ_OK);
        track_slot_t *slot = track_for_id(ctx, finfo.track_id);
        CHECK(slot != NULL);

        moq_cmaf_init_info_t init_info;
        moq_cmaf_init_info_init(&init_info);
        CHECK(moq_cmaf_parse_init(
                  (moq_bytes_t){slot->init.data, slot->init.len},
                  &init_info) == MOQ_OK);
        moq_cmaf_object_report_t report;
        moq_cmaf_object_report_init(&report);
        CHECK(moq_cmaf_validate_object(&init_info, bytes, &report) ==
              MOQ_ERR_PROTO);
        CHECK(report.reason == MOQ_CMAF_ERR_MULTI_TRACK);
        checked = true;
        break;
    }
    CHECK(checked);
    result = 0;

fail:
    buf_free(&fragment);
    buf_free(&file);
    return result;
}

static int test_init_has_matching_trex(const byte_buf_t *init,
                                       uint32_t track_id)
{
    size_t matching = 0;
    size_t other = 0;
    size_t pos = 0;
    while (pos < init->len) {
        mp4_box_t top;
        CHECK(mp4_box_at(init->data, init->len, pos, &top) == 0);
        if (top.type == MP4_TYPE('m', 'o', 'o', 'v')) {
            size_t child_pos = top.offset + top.header_size;
            size_t child_end = top.offset + top.size;
            while (child_pos < child_end) {
                mp4_box_t child;
                CHECK(mp4_box_at(init->data, child_end, child_pos, &child) == 0);
                if (child.type == MP4_TYPE('m', 'v', 'e', 'x')) {
                    size_t mvex_pos = child.offset + child.header_size;
                    size_t mvex_end = child.offset + child.size;
                    while (mvex_pos < mvex_end) {
                        mp4_box_t mvex_child;
                        CHECK(mp4_box_at(init->data, mvex_end, mvex_pos,
                                         &mvex_child) == 0);
                        if (mvex_child.type ==
                            MP4_TYPE('t', 'r', 'e', 'x')) {
                            CHECK(mvex_child.size - mvex_child.header_size >= 8);
                            uint32_t trex_id = read_be32(
                                init->data + mvex_child.offset +
                                mvex_child.header_size + 4);
                            if (trex_id == track_id) matching++;
                            else other++;
                        }
                        mvex_pos += mvex_child.size;
                    }
                }
                child_pos += child.size;
            }
        }
        pos += top.size;
    }
    CHECK(matching == 1);
    CHECK(other == 0);
    return 0;

fail:
    return -1;
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        fprintf(stderr,
                "usage: %s <track-separated-av.mp4> <interleaved-av.mp4>\n",
                argv[0]);
        return 2;
    }

    int result = 1;
    byte_buf_t file = {0};
    byte_buf_t fragment = {0};
    app_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));

    CHECK(test_stream_box_reader() == 0);
    CHECK(load_file(argv[1], &file) == 0);

    size_t pos = 0;
    while (pos < file.len) {
        mp4_box_t box;
        CHECK(mp4_box_at(file.data, file.len, pos, &box) == 0);
        if (box.type == MP4_TYPE('f', 't', 'y', 'p') ||
            box.type == MP4_TYPE('m', 'o', 'o', 'v')) {
            CHECK(buf_append(&ctx.init, file.data + box.offset, box.size) == 0);
        }
        pos += box.size;
    }

    CHECK(discover_tracks(&ctx) == 0);
    CHECK(ctx.track_count == 2);

    moq_bytes_t ns_part = {(const uint8_t *)"test", 4};
    moq_media_sender_cfg_t sender_cfg;
    init_sender_cfg(&sender_cfg, &ns_part, 1);
    CHECK(sender_cfg.struct_size == sizeof(sender_cfg));
#if MOQ5_HAVE_PUBLISH_TRACKS
    CHECK(sender_cfg.publish_tracks);
#endif
    CHECK(sender_cfg.namespace_.count == 1);

    bool have_audio = false;
    bool have_video = false;
    for (size_t i = 0; i < ctx.track_count; i++) {
        track_slot_t *slot = &ctx.tracks[i];
        size_t per_init_tracks = 0;
        CHECK(init_track_count(&slot->init, &per_init_tracks) == 0);
        CHECK(per_init_tracks == 1);

        moq_cmaf_init_info_t info;
        moq_cmaf_init_info_init(&info);
        CHECK(moq_cmaf_parse_init(
                  (moq_bytes_t){slot->init.data, slot->init.len}, &info) == MOQ_OK);
        CHECK(info.track_id == slot->track_id);
        CHECK(test_init_has_matching_trex(&slot->init, slot->track_id) == 0);
        CHECK(slot->codec[0] != '\0');

        moq_media_track_cfg_t cfg;
        fill_track_cfg(slot, &cfg);
        CHECK(cfg.packaging == MOQ_MEDIA_PACKAGING_CMAF);
        CHECK(cfg.init_data.data == slot->init.data);
        CHECK(cfg.init_data.len == slot->init.len);
        CHECK(cfg.codec.len > 0);
        CHECK(cfg.bitrate > 0);
        if (slot->media_type == MOQ_MEDIA_TYPE_AUDIO) {
            have_audio = true;
            CHECK(slot->samplerate > 0);
            CHECK(slot->channel_count > 0);
            CHECK(slot->channel_config[0] != '\0');
            CHECK(cfg.samplerate == slot->samplerate);
            CHECK(cfg.channel_config.len > 0);
        } else if (slot->media_type == MOQ_MEDIA_TYPE_VIDEO) {
            have_video = true;
            CHECK(slot->width > 0);
            CHECK(slot->height > 0);
        } else {
            CHECK(false);
        }
    }
    CHECK(have_audio && have_video);

    bool seen[MAX_TRACKS] = {false};
    pos = 0;
    while (pos < file.len) {
        mp4_box_t moof;
        CHECK(mp4_box_at(file.data, file.len, pos, &moof) == 0);
        if (moof.type != MP4_TYPE('m', 'o', 'o', 'f')) {
            pos += moof.size;
            continue;
        }

        mp4_box_t mdat;
        CHECK(mp4_box_at(file.data, file.len, pos + moof.size, &mdat) == 0);
        CHECK(mdat.type == MP4_TYPE('m', 'd', 'a', 't'));
        CHECK(buf_append(&fragment, file.data + moof.offset, moof.size) == 0);
        CHECK(buf_append(&fragment, file.data + mdat.offset, mdat.size) == 0);

        moq_cmaf_sample_t samples[512];
        moq_cmaf_fragment_info_t finfo;
        moq_cmaf_fragment_info_init(&finfo, samples,
                                    sizeof(samples) / sizeof(samples[0]));
        moq_bytes_t bytes = {fragment.data, fragment.len};
        CHECK(moq_cmaf_parse_fragment(bytes, &finfo) == MOQ_OK);
        track_slot_t *slot = track_for_id(&ctx, finfo.track_id);
        CHECK(slot != NULL);

        moq_cmaf_init_info_t init_info;
        moq_cmaf_init_info_init(&init_info);
        CHECK(moq_cmaf_parse_init(
                  (moq_bytes_t){slot->init.data, slot->init.len},
                  &init_info) == MOQ_OK);
        moq_cmaf_object_report_t report;
        moq_cmaf_object_report_init(&report);
        CHECK(moq_cmaf_validate_object(&init_info, bytes, &report) == MOQ_OK);

        for (size_t i = 0; i < ctx.track_count; i++) {
            if (&ctx.tracks[i] == slot) seen[i] = true;
        }
        fragment.len = 0;
        pos += moof.size + mdat.size;
    }
    for (size_t i = 0; i < ctx.track_count; i++) CHECK(seen[i]);
    CHECK(test_interleaved_fragment_rejected(argv[2], &ctx) == 0);

    fprintf(stderr, "PASS: discovered and routed %zu CMAF tracks\n",
            ctx.track_count);
    result = 0;

fail:
    buf_free(&fragment);
    clear_discovered_tracks(&ctx);
    buf_free(&ctx.init);
    buf_free(&file);
    return result;
}
