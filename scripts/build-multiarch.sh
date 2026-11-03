#!/usr/bin/env bash
# Build every service for the local machine, or push a multi-arch image to ECR.
# Local:  ./scripts/build-multiarch.sh
# ECR:    REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com PUSH=1 ./scripts/build-multiarch.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${TAG:-1.0.0}"
PUSH="${PUSH:-0}"
REGISTRY="${REGISTRY:-}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

if ! docker buildx inspect robot-builder >/dev/null 2>&1; then
  docker buildx create --name robot-builder --use
fi
docker buildx use robot-builder

services=(
  "one:robot-legs"
  "two:robot-hands"
  "three:robot-stomach"
  "four:robot-eyes"
  "five:robot-head"
)

if [[ "$PUSH" == "1" && "$REGISTRY" == *.amazonaws.com ]]; then
  region="$(sed -n 's/.*\.ecr\.\([^.]*\)\.amazonaws.com/\1/p' <<< "$REGISTRY")"
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$REGISTRY"
  for spec in "${services[@]}"; do
    name="${spec##*:}"
    aws ecr describe-repositories --repository-names "$name" --region "$region" >/dev/null 2>&1 || \
      aws ecr create-repository --repository-name "$name" --region "$region" \
        --image-scanning-configuration scanOnPush=true >/dev/null
  done
fi

for spec in "${services[@]}"; do
  dir="${spec%%:*}"
  name="${spec##*:}"
  args=(docker buildx build -t "${name}:${TAG}")
  if [[ -n "$REGISTRY" ]]; then
    args+=(-t "${REGISTRY%/}/${name}:${TAG}")
  fi
  args+=("$ROOT/$dir")
  if [[ "$PUSH" == "1" ]]; then
    args+=(--platform "$PLATFORMS" --push --provenance=false --sbom=false)
  else
    args+=(--load)
  fi
  "${args[@]}"
done
