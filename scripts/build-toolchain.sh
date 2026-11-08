#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -sm)" = 'Linux x86_64' ] || { echo 'Linux x64 required' >&2; exit 1; }
cache=.tmp/toolchain
mkdir -p "$cache"
fetch() {
  local name=$1 url=$2
  if [ ! -f "$cache/$name" ]; then
    curl --fail --location --silent --show-error --connect-timeout 15 --max-time 1200 "$url" -o "$cache/$name.partial"
    mv "$cache/$name.partial" "$cache/$name"
  fi
}
fetch agave.tar.bz2 https://github.com/anza-xyz/agave/releases/download/v4.4.1/solana-release-x86_64-unknown-linux-gnu.tar.bz2
fetch platform-tools.tar.bz2 https://github.com/anza-xyz/platform-tools/releases/download/v1.58/platform-tools-linux-x86_64.tar.bz2
fetch anchor https://github.com/otter-sec/anchor/releases/download/v1.2.2/anchor-1.2.2-x86_64-unknown-linux-gnu
fetch rustup-init https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init
cp docker/toolchain/anchor "$cache/anchor-shim"
cp docker/toolchain/cargo-build-sbf "$cache/cargo-build-sbf-shim"
printf '%s\n' '*' '!agave.tar.bz2' '!platform-tools.tar.bz2' '!anchor' '!rustup-init' '!anchor-shim' '!cargo-build-sbf-shim' > "$cache/.dockerignore"
docker build --platform linux/amd64 -f docker/toolchain/Dockerfile -t oms-toolchain:local "$cache"
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const image = execFileSync('docker', ['image', 'inspect', 'oms-toolchain:local', '--format', '{{.Id}}'], {encoding:'utf8'}).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Invalid local image ID');
writeFileSync('.tmp/toolchain/image.json',JSON.stringify({x64:image,arm64:null},null,2)+'\n');
JS
