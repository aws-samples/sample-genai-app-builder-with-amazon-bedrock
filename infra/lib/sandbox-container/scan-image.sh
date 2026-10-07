#!/usr/bin/env bash
# Vulnerability-scan a locally built sandbox image with Trivy.
#
#   scan-image.sh <image-ref>
#
# Fails (exit 1) when the image has HIGH or CRITICAL vulnerabilities that have
# a fixed version available. Unfixable findings are reported by ECR scanning
# but do not block, since nothing in this repo can remediate them.
#
# IMAGE_SCAN_ENFORCE=false switches to report-only (used by the weekly patch
# rebuild, where blocking would leave an even older, less patched image live).
# Accepted risks go in .trivyignore next to this script, one CVE per line with
# a reason and an `exp:YYYY-MM-DD` expiry.
#
# The scanner binary is pinned by version AND sha256: a tampered or
# re-tagged release fails the checksum and therefore fails the build.
set -euo pipefail

TRIVY_VERSION=0.74.0
TRIVY_SHA256=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a

IMAGE="${1:?usage: scan-image.sh <image-ref>}"
ENFORCE="${IMAGE_SCAN_ENFORCE:-true}"
HERE="$(cd "$(dirname "$0")" && pwd)"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

curl -sSfL --retry 3 -o "$workdir/trivy.tar.gz" \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
echo "${TRIVY_SHA256}  $workdir/trivy.tar.gz" | sha256sum -c -
tar -xzf "$workdir/trivy.tar.gz" -C "$workdir" trivy

exit_code=1
if [ "$ENFORCE" != "true" ]; then
  exit_code=0
  echo "IMAGE_SCAN_ENFORCE=$ENFORCE: reporting findings without failing the build"
fi

echo "Scanning $IMAGE for fixable HIGH/CRITICAL vulnerabilities (trivy $TRIVY_VERSION)"
"$workdir/trivy" image \
  --scanners vuln \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --ignorefile "$HERE/.trivyignore" \
  --exit-code "$exit_code" \
  --no-progress \
  --timeout 15m \
  "$IMAGE"
