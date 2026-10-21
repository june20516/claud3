#!/usr/bin/env bash
# 안정판 worktree를 직전 stable-N 태그로 되돌린다.
set -euo pipefail

STABLE_DIR="${CLAUD3_STABLE_DIR:-$HOME/.local/share/claud3/stable}"

if [[ ! -d "$STABLE_DIR" ]]; then
  echo "안정판 worktree가 없습니다: $STABLE_DIR" >&2
  exit 1
fi

current_tag="$(git -C "$STABLE_DIR" describe --tags --exact-match --match 'stable-*' 2> /dev/null || true)"
if [[ -z "$current_tag" ]]; then
  echo "안정판이 stable-N 태그를 가리키고 있지 않습니다." >&2
  exit 1
fi

previous_tag="stable-$(( ${current_tag#stable-} - 1 ))"
if ! git -C "$STABLE_DIR" rev-parse --quiet --verify "refs/tags/$previous_tag" > /dev/null; then
  echo "되돌릴 이전 안정판($previous_tag)이 없습니다. 현재 안정판: $current_tag" >&2
  exit 1
fi

git -C "$STABLE_DIR" checkout --quiet --detach "$previous_tag"
(cd "$STABLE_DIR" && npm ci && npm run build)

echo "안정판: $previous_tag (이전: $current_tag)"
