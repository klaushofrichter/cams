#!/usr/bin/env bash
# Regenerates the mock camera's media fixtures with ffmpeg: synthetic test
# pattern and tone, no real footage. Outputs are committed; CI never runs this.
set -euo pipefail
dir=test/mock-camera/fixtures
mkdir -p "$dir"
ffmpeg -v error -y -f lavfi -i testsrc=size=320x180:rate=10 -f lavfi -i sine=frequency=440:sample_rate=16000 \
  -t 20 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 10 -c:a aac -b:a 32k -f flv "$dir/live.flv"
ffmpeg -v error -y -f lavfi -i testsrc=size=320x180 -frames:v 1 "$dir/snapshot.jpg"
ls -l "$dir"
