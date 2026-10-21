#!/usr/bin/env bash
# 현재 커밋을 안정판으로 승격한다: 테스트·빌드 통과 → stable-N 태그 → 안정판 worktree 갱신 → 전역 claud3 연결.
set -euo pipefail

STABLE_DIR="${CLAUD3_STABLE_DIR:-$HOME/.local/share/claud3/stable}"
REPO_DIR="$(git rev-parse --show-toplevel)"
cd "$REPO_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "작업 트리에 커밋하지 않은 변경이 있어 승격하지 않습니다." >&2
  exit 1
fi

npm test
npm run build

last_number="$(git tag --list 'stable-*' | sed 's/^stable-//' | grep -E '^[0-9]+$' | sort -n | tail -1 || true)"
next_tag="stable-$(( ${last_number:-0} + 1 ))"
git tag "$next_tag"

if [[ -d "$STABLE_DIR" ]]; then
  git -C "$STABLE_DIR" checkout --quiet --detach "$next_tag"
else
  mkdir -p "$(dirname "$STABLE_DIR")"
  git worktree add --detach "$STABLE_DIR" "$next_tag"
fi

(cd "$STABLE_DIR" && npm ci && npm run build)

if ! command -v claud3 > /dev/null; then
  (cd "$STABLE_DIR" && npm link)
fi

echo "안정판: $next_tag"
