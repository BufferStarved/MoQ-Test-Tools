# Native ffmpeg MoQ (draft-18, OpenMOQ moq5 / libmoq)

Stock ffmpeg has no `-f moq`. OpenMOQ **moq5** is the C stack (`libmoq` +
`moq5-fmp4-publish`). Native integration is two layers:

1. **In-process libavformat (ships now):** `ffmoq` remuxes through a custom
   AVIO that calls `fmp4_moq_feed()`.
2. **In-tree ffmpeg protocol (build locally):** `moq://` so stock-style
   `ffmpeg … -f mp4 moq://host:14433/moq-relay?namespace=…` works.

Do not change the live canary pipe until headed playa on `:14433` is green.

## API (`fmp4_moq`)

`tools/moq5-publisher/fmp4_moq_bridge.h`:

```c
fmp4_moq_bridge_t *fmp4_moq_connect(const char *url, const char *namespace_,
                                    const fmp4_moq_opts_t *opts);
int fmp4_moq_feed(fmp4_moq_bridge_t *b, const uint8_t *data, size_t len);
int fmp4_moq_close(fmp4_moq_bridge_t *b);
```

Input is CMAF (`moof`+`mdat`) with `+separate_moof`, not annex-B.

## Build moq5 + ffmoq

```bash
cmake -S tools/moq5-publisher -B tools/moq5-publisher/build \
  -DMOQ5_PREFIX="$PWD/tools/moq5/install" \
  -DMOQ_PICOQUIC_SOURCE_DIR="$PWD/tools/deps/picoquic"
cmake --build tools/moq5-publisher/build
ctest --test-dir tools/moq5-publisher/build --output-on-failure
```

Produces `libfmp4_moq.a`, `moq5-fmp4-publish`, `moq_link_spike`, and `ffmoq`
when pkg-config finds libavformat.

### ffmoq (libavformat + libmoq, one process)

```bash
tools/moq5-publisher/build/ffmoq \
  https://34-28-164-90.sslip.io:14433/moq-relay \
  ffmoq-d18-$(date +%s) \
  tools/moq5-publisher/build/moq5-multitrack-fixture.mp4
```

Remux only (`-c copy` equivalent). Live encode still uses ffmpeg CLI until
the `moq:` protocol is built.

## ffmpeg `moq:` protocol

```bash
./scripts/build-ffmpeg-libmoq.sh
```

Installs `tools/ffmpeg-moq/prefix/bin/ffmpeg` (does not replace Homebrew).
Source: `tools/ffmpeg-moq/libavformat/libmoq.c`. After a successful local
build, `ffmpeg -protocols` lists `moq`. Confirm with
`ffmpeg -h protocol=moq` (`namespace`, `insecure`, `qlog`).

```bash
tools/ffmpeg-moq/prefix/bin/ffmpeg -re -i input.mp4 \
  -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac \
  -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof \
  -f mp4 'moq://34-28-164-90.sslip.io:14433/moq-relay?namespace=ffmoq-d18'
```

Do not point this at prod `:4433`.

## Prior art (do not copy)

There is no IETF draft-18 `-f moq` in ffmpeg.git. `moq-dev` / `moq-cli` / hang / GStreamer / OBS are **moq-lite + hang**, not OpenMOQ moq5 + playa. `englishm/libmoq` is an abandoned 2023 FFI sketch. Our analogue is SRT: a write-only `URLProtocol` (`moq:`) plus the existing CMAF muxer, calling OpenMOQ `libmoq`.
