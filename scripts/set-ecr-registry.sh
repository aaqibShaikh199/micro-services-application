#!/usr/bin/env bash
# Point Kubernetes images at an ECR registry.
# Usage: ./scripts/set-ecr-registry.sh 123456789012.dkr.ecr.us-east-1.amazonaws.com
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 123456789012.dkr.ecr.us-east-1.amazonaws.com" >&2
  exit 1
fi

REGISTRY="${1%/}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

python3 - "$REGISTRY" "$ROOT" << 'PY'
import pathlib, re, sys
registry, root = sys.argv[1], pathlib.Path(sys.argv[2])
image = re.compile(r"image:\s+(?:\S+/)?(robot-[a-z0-9-]+):([A-Za-z0-9._-]+)")
for path in root.rglob("*.yaml"):
    text = path.read_text()
    updated, count = image.subn(lambda match: f"image: {registry}/{match.group(1)}:{match.group(2)}", text)
    updated = updated.replace("imagePullPolicy: IfNotPresent", "imagePullPolicy: Always")
    if updated != text:
        path.write_text(updated)
        print(f"{path.relative_to(root)} ({count} image{'s' if count != 1 else ''})")
PY
