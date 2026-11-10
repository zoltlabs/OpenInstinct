#!/bin/sh
# Vercel: exit 0 skips; exit 1 builds. Run from the project's root directory.
if [ "${VERCEL_ENV:-}" = preview ]; then
  echo 'Skip: preview deployments disabled'
  exit 0
fi
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
set --
while IFS= read -r path; do
  [ -z "$path" ] || set -- "$@" "$path"
done < scripts/vercel-build-paths.txt
base=${VERCEL_GIT_PREVIOUS_SHA:-}
if [ -z "$base" ]; then
  echo 'Build: no previous successful deployment'
  exit 1
fi
echo "Compare previous deployment $base to HEAD"
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo 'Previous deployment absent from clone; fetching comparison commit'
  if ! git fetch --no-tags --depth=1 origin "$base"; then
    echo 'Build: could not fetch comparison commit'
    exit 1
  fi
fi
git diff --quiet "$base" HEAD -- "$@" scripts/vercel-ignore-build.sh scripts/vercel-build-paths.txt
result=$?
if [ "$result" -eq 0 ]; then
  echo 'Skip: no project or dependency changes since previous deployment'
  exit 0
fi
if [ "$result" -eq 1 ]; then
  echo 'Build: project or dependency changes since previous deployment'
  git diff --name-only "$base" HEAD -- "$@" scripts/vercel-ignore-build.sh scripts/vercel-build-paths.txt
else
  echo 'Build: comparison failed'
fi
exit 1
