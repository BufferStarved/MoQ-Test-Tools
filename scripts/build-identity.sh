#!/usr/bin/env bash
# Prod vs dev build identity.
#
# Two environments, one SHA scheme:
#   prod  — short HEAD, no suffix. The hosted site. Always exported from a
#           committed tree so a dirty laptop cannot become the prod build.
#   dev   — short HEAD + "-dev". Local API (:8000) and Vite (:5173).
#
# There is no "-dirty". A dirty working tree is either kept on dev, or it is
# not what prod deploys.

set -euo pipefail

: "${ROOT_DIR:?ROOT_DIR must be set}"

MOQ_ENV="${MOQ_ENV:-}"
if [[ -z "$MOQ_ENV" ]]; then
  echo "build-identity: set MOQ_ENV=prod or MOQ_ENV=dev" >&2
  return 2 2>/dev/null || exit 2
fi
if [[ "$MOQ_ENV" != "prod" && "$MOQ_ENV" != "dev" ]]; then
  echo "build-identity: MOQ_ENV must be prod or dev, got '$MOQ_ENV'" >&2
  return 2 2>/dev/null || exit 2
fi

GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ "$MOQ_ENV" == "dev" && "$GIT_SHA" != *-dev ]]; then
  GIT_SHA="${GIT_SHA}-dev"
fi
export MOQ_ENV GIT_SHA
