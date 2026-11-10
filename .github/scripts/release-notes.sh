#!/usr/bin/env bash
# Prints the release notes for one version: the CHANGELOG.md section between
# "## [<version>]" and the next "## " heading. Exits 1 (with an error
# annotation) when the section is missing or empty.
#
# Usage: bash .github/scripts/release-notes.sh <version>   # e.g. 1.2.0
set -euo pipefail

version="${1:?usage: release-notes.sh <version>}"

notes="$(awk -v ver="$version" '
  index($0, "## [" ver "]") == 1 { found = 1; next }
  found && /^## /                { exit }
  found                          { print }
' CHANGELOG.md)"

if ! grep -q '[^[:space:]]' <<<"$notes"; then
  echo "::error::CHANGELOG.md has no section for version $version — add '## [$version]'." >&2
  exit 1
fi

printf '%s\n' "$notes"
