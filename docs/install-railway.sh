#!/bin/sh
set -eu
# GitLab's hosted Linux runners are x86_64. Pin the official binary and its release checksum.
test "$(uname -m)" = x86_64
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl --fail --location --retry 3 --output "$archive" \
  https://github.com/railwayapp/cli/releases/download/v5.57.11/railway-v5.57.11-x86_64-unknown-linux-musl.tar.gz
printf '%s  %s\n' 0d40e1d7e4f6e204b2a49ebaf21c77f3cb6da5deec632024fc6338b32e14bb30 "$archive" | sha256sum --check
tar -xzf "$archive" -C /usr/local/bin railway
railway --version
