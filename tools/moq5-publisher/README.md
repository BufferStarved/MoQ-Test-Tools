# moq5 fragmented-MP4 publisher

`moq5-fmp4-publish` reads fragmented MP4 from standard input and publishes its
audio and video tracks through libmoq's media-sender service API. The service
derives and pushes the MSF catalog, including one CMAF initialization segment
for each track.

The input must put each track in a separate `moof` + `mdat` pair. FFmpeg's
`+separate_moof` flag provides that layout:

```bash
ffmpeg -re -i input.mp4 \
  -map 0:v:0 -map 0:a:0? \
  -c:v libx264 -c:a aac \
  -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof \
  -f mp4 - | \
  moq5-fmp4-publish https://relay.example:4433/moq-relay live/demo
```

The initialization `moov` may contain multiple `trak` boxes. The publisher
extracts a track-specific init segment and catalog entry for each supported
audio/video track, then routes each track-separated fragment by `track_ID`.
The current ingest path emits complete catalog metadata for H.264 + AAC (the
default pipeline) and Opus. It rejects codecs whose full RFC 6381 identifier
cannot yet be derived instead of advertising incomplete decoder metadata.
Interleaved multi-track fragments without `+separate_moof` are rejected rather
than being attributed to the first track.

The sender runs in publisher-initiated mode (`publish_tracks = true`), which is
the mode needed when publishing through a relay. Applications do not need to
construct catalog JSON themselves.

## Build and test

Set `MOQ5_PREFIX` to an installed libmoq prefix with the service component and
configure normally:

```bash
cmake -S . -B build -DMOQ5_PREFIX=/path/to/libmoq/install
cmake --build build
ctest --test-dir build --output-on-failure
```

When FFmpeg is available, CTest generates an H.264 + AAC fixture and verifies
that both tracks receive distinct init segments with matching `trex` defaults,
that every track-separated fragment routes to the matching track, and that an
interleaved multi-track fragment is rejected.
