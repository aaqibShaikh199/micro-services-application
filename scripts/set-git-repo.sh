#!/usr/bin/env bash
# Point the Argo CD applications at your Git repository.
# Usage: ./scripts/set-git-repo.sh https://github.com/you/robot-microservices.git
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 https://github.com/you/robot-microservices.git" >&2
  exit 1
fi

REPO="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$REPO" "$ROOT/platform/argocd/applications.yaml" << 'PY'
import re, sys
repo, path = sys.argv[1:]
file = open(path)
text = file.read()
file.close()
updated, count = re.subn(r"repoURL:\s+\S+", f"repoURL: {repo}", text)
if count == 0:
    raise SystemExit("no repoURL fields found")
open(path, "w").write(updated)
print(f"updated {count} repoURL fields")
PY
