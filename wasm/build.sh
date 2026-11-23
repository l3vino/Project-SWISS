#!/usr/bin/env bash
# Rebuilds wasm/core.wasm from the C sources listed below
#
# You do not need to run this. core.wasm is committed and the app loads it
# directly. Run it only if you edit the C.
#
# Needs: clang 15+ with wasm-ld: the one in ../.toolchain if it is there (wasi-sdk, unpacked in the project folder and
# kept out of git: Stage 5.18c), else clang on the PATH; optionally wasm-opt (binaryen) on the PATH.
set -euo pipefail
cd "$(dirname "$0")"

OUT=core.wasm

CLANG=clang
for c in ../.toolchain/wasi-sdk-*/bin/clang.exe ../.toolchain/wasi-sdk-*/bin/clang; do
  if [ -x "$c" ]; then CLANG="$c"; break; fi
done

"$CLANG" \
  --target=wasm32-unknown-unknown \
  -O3 -flto -msimd128 -mbulk-memory \
  -nostdlib -ffreestanding \
  -fno-builtin-memcpy -fno-builtin-memset \
  -fvisibility=hidden \
  -Wall -Wextra \
  -Wl,--no-entry \
  -Wl,--export-dynamic \
  -Wl,--strip-all \
  -Wl,--initial-memory=1048576 \
  -Wl,--lto-O3 \
  -o "$OUT" \
  src/core.c src/mathf.c src/qm.c src/ground.c src/mesh.c src/solid.c src/bc.c src/mvt.c src/shape.c src/tunnel.c src/track.c \
  src/profile.c

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-simd --enable-bulk-memory --strip-debug --strip-producers \
    "$OUT" -o "$OUT.opt" && mv "$OUT.opt" "$OUT"
fi

printf 'built %s (%s bytes)\n' "$OUT" "$(stat -c%s "$OUT")"
