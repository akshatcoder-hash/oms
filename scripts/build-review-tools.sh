#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -sm)" = 'Linux x86_64' ] || { echo 'Linux x64 required' >&2; exit 1; }
toolchain=${OMS_TOOLCHAIN_IMAGE:-$(node -e "const f='.tmp/toolchain/image.json'; const fs=require('node:fs'); process.stdout.write(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')).x64 ?? '' : '')")}
[[ $toolchain =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'No local toolchain image; run scripts/build-toolchain.sh or set OMS_TOOLCHAIN_IMAGE' >&2; exit 1; }
[ -f .tmp/review-tools/advisory-db.tar ] || { echo 'Missing .tmp/review-tools/advisory-db.tar; see docker/review-tools/README.md' >&2; exit 1; }
tar -czf .tmp/review-tools/context.tar.gz docker/review-tools/Dockerfile tools/oms-sast .tmp/review-tools/advisory-db.tar
docker build --build-arg TOOLCHAIN_IMAGE="$toolchain" -f docker/review-tools/Dockerfile -t oms-review-tools:local - < .tmp/review-tools/context.tar.gz
image=$(docker image inspect oms-review-tools:local --format '{{.Id}}')
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid local image ID' >&2; exit 1; }
printf '{\n  "x64": "%s",\n  "arm64": null\n}\n' "$image" > .tmp/review-tools/image.json
