#!/usr/bin/env bash
# Build a local ffmpeg 8.x with the OpenMOQ moq: protocol (libmoq / moq5).
# Does not replace Homebrew ffmpeg. Output: tools/ffmpeg-moq/prefix/bin/ffmpeg
#
# Requires a prior moq5 publisher build (libfmp4_moq.a + libmoq).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FFMPEG_TAG="${FFMPEG_TAG:-n8.1.2}"
SRC="${FFMPEG_SRC:-$ROOT/tools/ffmpeg-moq/ffmpeg-src}"
PREFIX="${FFMPEG_MOQ_PREFIX:-$ROOT/tools/ffmpeg-moq/prefix}"
PUB_BUILD="$ROOT/tools/moq5-publisher/build"
PUB_INC="$ROOT/tools/moq5-publisher"

if [[ ! -f "$PUB_BUILD/libfmp4_moq.a" ]]; then
  echo "Build moq5 first:" >&2
  echo "  cmake -S tools/moq5-publisher -B tools/moq5-publisher/build \\" >&2
  echo "    -DMOQ5_PREFIX=\"\$PWD/tools/moq5/install\" \\" >&2
  echo "    -DMOQ_PICOQUIC_SOURCE_DIR=\"\$PWD/tools/deps/picoquic\"" >&2
  echo "  cmake --build tools/moq5-publisher/build" >&2
  exit 1
fi

LINK_TXT="$PUB_BUILD/CMakeFiles/moq5-fmp4-publish.dir/link.txt"
if [[ ! -f "$LINK_TXT" ]]; then
  echo "missing $LINK_TXT (rebuild moq5-fmp4-publish)" >&2
  exit 1
fi

# CMake's link.txt uses build-dir-relative picoquic archives. Resolve them
# so ffmpeg's configure (cwd = ffmpeg-src) can still link the C compiler test.
EXTRA_LIBS=""
# shellcheck disable=SC2013
for tok in $(tr ' ' '\n' < "$LINK_TXT"); do
  case "$tok" in
    *.o|moq5-fmp4-publish|-o|-O*|-DNDEBUG|-Wl,*) continue ;;
    libfmp4_moq.a) tok="$PUB_BUILD/libfmp4_moq.a" ;;
    *.a|*.dylib|*.so)
      if [[ "$tok" != /* ]]; then
        tok="$PUB_BUILD/$tok"
      fi
      ;;
    *) continue ;;
  esac
  if [[ ! -e "$tok" ]]; then
    echo "missing link input $tok" >&2
    exit 1
  fi
  case " $EXTRA_LIBS " in
    *" $tok "*) continue ;;
  esac
  EXTRA_LIBS="$EXTRA_LIBS $tok"
done
# picoquic / picotls need these on Darwin when libmoq.o is linked into libavformat.
# Single tokens so --extra-libs="..." quoting cannot glue -framework onto the name.
if [[ "$(uname -s)" == "Darwin" ]]; then
  EXTRA_LIBS="$EXTRA_LIBS -lpthread -Wl,-framework,Security -Wl,-framework,CoreFoundation"
fi

if [[ ! -d "$SRC/.git" ]]; then
  git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$SRC"
fi

cp "$ROOT/tools/ffmpeg-moq/libavformat/libmoq.c" "$SRC/libavformat/libmoq.c"

PROTOCOLS_C="$SRC/libavformat/protocols.c"
if ! grep -q 'ff_libmoq_protocol' "$PROTOCOLS_C"; then
  python3 - "$PROTOCOLS_C" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
needle = "extern const URLProtocol ff_libsrt_protocol;\n"
insert = needle + "extern const URLProtocol ff_libmoq_protocol;\n"
if needle not in text:
    sys.exit("ff_libsrt_protocol not found in protocols.c; ffmpeg layout changed")
if "ff_libmoq_protocol" not in text:
    p.write_text(text.replace(needle, insert, 1))
PY
fi

MAKEFILE="$SRC/libavformat/Makefile"
if ! grep -q 'CONFIG_LIBMOQ_PROTOCOL' "$MAKEFILE"; then
  # n8.1 pads these lines; match the real LIBSRT row instead of a collapsed form.
  python3 - "$MAKEFILE" <<'PY'
from pathlib import Path
import re
import sys
p = Path(sys.argv[1])
text = p.read_text()
if "CONFIG_LIBMOQ_PROTOCOL" in text:
    raise SystemExit(0)
match = re.search(r"^OBJS-\$\(CONFIG_LIBSRT_PROTOCOL\).+\n", text, re.M)
if not match:
    sys.exit("libsrt Makefile line not found; ffmpeg layout changed")
insert = "OBJS-$(CONFIG_LIBMOQ_PROTOCOL)           += libmoq.o\n"
p.write_text(text[: match.end()] + insert + text[match.end() :])
PY
fi

CONFIGURE="$SRC/configure"
if ! grep -q 'libmoq_protocol' "$CONFIGURE"; then
  python3 - "$CONFIGURE" <<'PY'
from pathlib import Path
import re
import sys
p = Path(sys.argv[1])
text = p.read_text()

def once(old: str, new: str, label: str) -> None:
    global text
    if new.strip() in text:
        return
    if old not in text:
        sys.exit(f"{label} not found; ffmpeg layout changed")
    text = text.replace(old, new, 1)

once(
    '    libsrt\n',
    '    libsrt\n    libmoq\n',
    "EXTERNAL_LIBRARY_LIST libsrt",
)
once(
    '  --enable-libsrt          enable Haivision SRT protocol via libsrt [no]\n',
    '  --enable-libsrt          enable Haivision SRT protocol via libsrt [no]\n'
    '  --enable-libmoq          enable OpenMOQ moq5 (libmoq) protocol [no]\n',
    "--enable-libsrt help",
)
once(
    'libsrt_protocol_deps="libsrt"\nlibsrt_protocol_select="network"\n',
    'libsrt_protocol_deps="libsrt"\nlibsrt_protocol_select="network"\n'
    'libmoq_protocol_deps="libmoq"\nlibmoq_protocol_select="network"\n',
    "libsrt protocol deps",
)
# libmoq is linked via --extra-cflags/--extra-libs; no pkg-config probe.
p.write_text(text)
PY
fi

mkdir -p "$PREFIX"
cd "$SRC"
./configure \
  --prefix="$PREFIX" \
  --disable-static --enable-shared \
  --enable-gpl --enable-libx264 --enable-libopus \
  --enable-libmoq \
  --extra-cflags="-I${PUB_INC}" \
  --extra-ldflags="-L${PUB_BUILD}" \
  --extra-libs="$EXTRA_LIBS"

JOBS="${FFMPEG_JOBS:-}"
if [[ -z "$JOBS" ]]; then
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || true)"
fi
if [[ -z "$JOBS" || "$JOBS" = *[!0-9]* ]]; then
  JOBS=4
fi
make -j"$JOBS"
make install

echo
echo "Patched ffmpeg: $PREFIX/bin/ffmpeg"
echo "Example:"
echo "  $PREFIX/bin/ffmpeg -re -i input.mp4 -c:v libx264 -pix_fmt yuv420p -g 30 \\"
echo "    -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof \\"
echo "    -f mp4 'moq://34-28-164-90.sslip.io:14433/moq-relay?namespace=ffmoq-d18'"
