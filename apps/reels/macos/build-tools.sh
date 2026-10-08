#!/usr/bin/env bash
# Builds self-contained FFmpeg, FFprobe and whisper-cli for OpenCut.app, so the
# app works without Homebrew. Output: .tools/bin (+ .tools/licenses).
#
#   bash macos/build-tools.sh
#
# Takes about 10 minutes the first time; later runs reuse .tools if the versions
# below haven't changed. Needs the Xcode Command Line Tools and CMake.
#
# FFmpeg is built with only macOS's own frameworks (VideoToolbox for H.264, zlib),
# so it is LGPL and links nothing outside /usr/lib and /System. whisper.cpp is
# linked statically with its Metal (GPU) shaders embedded.
set -euo pipefail

FFMPEG_VERSION="9.0.2"
WHISPER_VERSION="v1.9.5"
MACOS_MIN="13.3" # whisper.cpp uses Accelerate (BLAS) calls added in macOS 13.3

cd "$(dirname "$0")/.."
OUT="$PWD/.tools"
STAMP="ffmpeg-$FFMPEG_VERSION whisper-$WHISPER_VERSION macos-$MACOS_MIN $(uname -m)"
if [[ -f "$OUT/stamp" && "$(cat "$OUT/stamp")" == "$STAMP" && -x "$OUT/bin/ffmpeg" && -x "$OUT/bin/whisper-cli" ]]; then
  echo "✓ Tools already built ($STAMP)"
  exit 0
fi

[[ "$(uname)" == "Darwin" ]] || { echo "Build the tools on a Mac." >&2; exit 1; }
command -v cmake >/dev/null || { echo "Install CMake first: brew install cmake" >&2; exit 1; }

export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
JOBS="$(sysctl -n hw.ncpu)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/licenses"

echo "→ FFmpeg $FFMPEG_VERSION"
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" | tar -xJ -C "$WORK"
(
  cd "$WORK/ffmpeg-$FFMPEG_VERSION"
  # --disable-autodetect keeps Homebrew libraries out; the frameworks we want are enabled by name.
  ./configure \
    --prefix="$WORK/ffmpeg-out" \
    --disable-autodetect --disable-debug --disable-doc --disable-ffplay --disable-network \
    --enable-videotoolbox --enable-audiotoolbox --enable-zlib \
    --extra-cflags="-mmacosx-version-min=$MACOS_MIN" --extra-ldflags="-mmacosx-version-min=$MACOS_MIN" \
    >/dev/null
  make -j"$JOBS" >/dev/null
  cp ffmpeg ffprobe "$OUT/bin/"
  cp COPYING.LGPLv2.1 "$OUT/licenses/FFmpeg-LGPL-2.1.txt"
  echo "FFmpeg $FFMPEG_VERSION, built with: $(./ffmpeg -hide_banner -buildconf | tr -s ' \n' ' ' | sed 's/^ *//')" > "$OUT/licenses/FFmpeg-build.txt"
  echo "Source: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" >> "$OUT/licenses/FFmpeg-build.txt"
)

echo "→ whisper.cpp $WHISPER_VERSION"
git clone --quiet --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp "$WORK/whisper.cpp"
cmake -S "$WORK/whisper.cpp" -B "$WORK/whisper-build" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_MIN" >/dev/null
cmake --build "$WORK/whisper-build" --config Release --target whisper-cli -j"$JOBS" >/dev/null
cp "$WORK/whisper-build/bin/whisper-cli" "$OUT/bin/"
cp "$WORK/whisper.cpp/LICENSE" "$OUT/licenses/whisper.cpp-MIT.txt"

echo "→ Checking the tools only need macOS itself"
for bin in "$OUT"/bin/*; do
  strip -x "$bin"
  outside="$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/)' || true)"
  if [[ -n "$outside" ]]; then
    echo "$(basename "$bin") links libraries a Mac doesn't have:" >&2
    echo "$outside" >&2
    exit 1
  fi
done
"$OUT/bin/ffmpeg" -hide_banner -version | head -1
"$OUT/bin/ffmpeg" -hide_banner -encoders | grep -q h264_videotoolbox
"$OUT/bin/whisper-cli" --help >/dev/null 2>&1 || "$OUT/bin/whisper-cli" -h >/dev/null 2>&1
du -sh "$OUT/bin"/*
echo "$STAMP" > "$OUT/stamp"
echo "✓ Tools in $OUT/bin"
