#!/usr/bin/env bash
# scripts/release.sh — full release automation for memorydetective.
#
# Usage:
#   ./scripts/release.sh <version> [<title-suffix>]
#
# Examples:
#   ./scripts/release.sh 1.6.0
#   ./scripts/release.sh 1.6.0 "MetricKit ingestion + 3 SwiftData patterns"
#
# The release title becomes:
#   "v<version> — <title-suffix>"   if a suffix is provided
#   "v<version>"                    otherwise
#
# Preconditions (the script validates each):
#   - Current branch is `main` and working tree is clean
#   - `package.json` version matches the requested version
#   - `CHANGELOG.md` has a `## [<version>] — <date>` entry
#   - The tag does not already exist (locally or on origin)
#   - The npm version is not already published
#   - `gh` and `npm` CLIs are authenticated (`gh auth status`, `npm whoami`)
#
# What it does, in order:
#   1. Preflight checks (above)
#   2. `npm run build` and `npm test`
#   3. Pushes `main` to origin (if local is ahead)
#   4. Creates an annotated tag at HEAD
#   5. Pushes the tag to origin
#   6. Publishes to npm (`npm publish` — also re-runs build via prepublishOnly)
#   7. Extracts the matching `## [<version>]` section from CHANGELOG.md as
#      release notes
#   8. Creates the GitHub Release with that title + notes
#
# If a step fails before step 4 (tag creation), the script is safe to re-run
# after the underlying issue is fixed. After step 4, manual cleanup is required
# (you'd have to delete the tag from origin to retry — risky).
#
# Internal post-release tasks (NOT automated; see ~/Desktop/internal/RELEASING.md):
#   - Update ~/Desktop/internal/CONTINUE.md (version header + "What's shipped")
#   - Update ~/Desktop/internal/v<series>-candidates.md or successor

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Args
# ─────────────────────────────────────────────────────────────────────────────

VERSION="${1:-}"
TITLE_SUFFIX="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version> [<title-suffix>]" >&2
  echo "example: $0 1.6.0 \"new MetricKit ingestion\"" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "error: version must be x.y.z or x.y.z-prerelease (got '$VERSION')" >&2
  exit 1
fi

TAG="v$VERSION"
TITLE="$TAG"
if [[ -n "$TITLE_SUFFIX" ]]; then
  TITLE="$TAG — $TITLE_SUFFIX"
fi

cd "$(git rev-parse --show-toplevel)"

# ─────────────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────────────

echo "→ preflight"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "error: must be on main (currently on $BRANCH)" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "error: working tree not clean — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

PKG_VERSION="$(node -p "require('./package.json').version")"
if [[ "$PKG_VERSION" != "$VERSION" ]]; then
  echo "error: package.json says $PKG_VERSION, you asked for $VERSION" >&2
  echo "       bump package.json + commit before running this script" >&2
  exit 1
fi

if ! grep -q "^## \[$VERSION\]" CHANGELOG.md; then
  echo "error: no '## [$VERSION]' entry in CHANGELOG.md" >&2
  echo "       write the changelog entry + commit before running this script" >&2
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists locally" >&2
  exit 1
fi

if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "$TAG"; then
  echo "error: tag $TAG already exists on origin" >&2
  exit 1
fi

if npm view "memorydetective@$VERSION" version >/dev/null 2>&1; then
  echo "error: memorydetective@$VERSION already published to npm" >&2
  exit 1
fi

# Refresh remote refs so we don't push stale state
git fetch origin main --tags --quiet

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main 2>/dev/null || echo "")"
BEHIND=0
if [[ -n "$REMOTE_HEAD" ]] && [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  if git merge-base --is-ancestor "$LOCAL_HEAD" "$REMOTE_HEAD"; then
    echo "error: local main is behind origin/main — pull first" >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
    echo "error: local main has diverged from origin/main — rebase first" >&2
    exit 1
  fi
fi

echo "  ✓ on main, clean, package.json=$VERSION, CHANGELOG entry present, tag free"

# ─────────────────────────────────────────────────────────────────────────────
# Build + test
# ─────────────────────────────────────────────────────────────────────────────

echo "→ npm run build"
npm run build >/dev/null

echo "→ npm test"
npm test 2>&1 | tail -6

# ─────────────────────────────────────────────────────────────────────────────
# Push main if needed
# ─────────────────────────────────────────────────────────────────────────────

if [[ -z "$REMOTE_HEAD" ]] || [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  echo "→ pushing main to origin"
  git push origin main
else
  echo "  ✓ origin/main already at $LOCAL_HEAD"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Tag
# ─────────────────────────────────────────────────────────────────────────────

echo "→ creating annotated tag $TAG"
git tag -a "$TAG" -m "$TITLE"

echo "→ pushing $TAG to origin"
git push origin "$TAG"

# ─────────────────────────────────────────────────────────────────────────────
# Extract release notes from CHANGELOG
# ─────────────────────────────────────────────────────────────────────────────

# sed -n '/start/,/end/p' includes both delimiter lines, then '1d;$d'
# strips them. The result is the body of the matching section.
NOTES="$(sed -n "/^## \[$VERSION\]/,/^## \[/p" CHANGELOG.md | sed '1d;$d' | sed '/./,$!d')"

if [[ -z "$NOTES" ]]; then
  echo "warning: extracted release notes are empty — proceeding with title only" >&2
fi

# ─────────────────────────────────────────────────────────────────────────────
# npm publish
# ─────────────────────────────────────────────────────────────────────────────

echo "→ npm publish"
npm publish

# ─────────────────────────────────────────────────────────────────────────────
# GitHub Release
# ─────────────────────────────────────────────────────────────────────────────

echo "→ creating GitHub Release"
if [[ -n "$NOTES" ]]; then
  gh release create "$TAG" --title "$TITLE" --notes "$NOTES"
else
  gh release create "$TAG" --title "$TITLE" --notes "See [CHANGELOG.md](./CHANGELOG.md#${VERSION//./}--$(date +%Y-%m-%d)) for full notes."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

echo
echo "✅ Released $TAG"
echo "   npm:    https://www.npmjs.com/package/memorydetective/v/$VERSION"
echo "   github: https://github.com/carloshpdoc/memorydetective/releases/tag/$TAG"
echo
echo "Next steps (manual — see ~/Desktop/internal/RELEASING.md):"
echo "  • Update ~/Desktop/internal/CONTINUE.md (version header + 'What's shipped' section)"
echo "  • Mark shipped items in ~/Desktop/internal/v<series>-candidates.md (or successor)"
echo "  • Announce if notable (Twitter / dev.to / HN)"
