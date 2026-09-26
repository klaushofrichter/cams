#!/usr/bin/env bash
# Synthetic recording clips for the mock camera: fragmented MP4 like the
# camera's Download returns (seekable in a browser). Committed; CI never runs this.
set -euo pipefail
dir=test/mock-camera/fixtures
for spec in "sub 320x180" "main 640x360"; do
  set -- $spec
  ffmpeg -v error -y -f lavfi -i "testsrc=size=$2:rate=10" -f lavfi -i sine=frequency=660:sample_rate=16000 \
    -t 12 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 10 -c:a aac -b:a 32k \
    -movflags frag_keyframe+empty_moov+default_base_moof "$dir/clip-$1.mp4"
done
ls -l "$dir"/clip-*.mp4
