#!/bin/bash
set -e

if [[ $(node ./scripts/check-already-published.js) = "not published" ]]; then
  if [[  -z "$TAG" ]]; then
    npm publish --provenance --tag canary
    echo "Published canary."
    curl https://purge.jsdelivr.net/npm/@zenvor/hls.js@canary
    curl https://purge.jsdelivr.net/npm/@zenvor/hls.js@canary/dist/hls-demo.js
    echo "Cleared jsdelivr cache."
  else
    tag=$(node ./scripts/get-version-tag.js)
    if [ "${tag}" = "canary" ]; then
      # canary is blocked because this is handled separately on every commit
      echo "canary not supported as explicit tag"
      exit 1
    fi
    sanitizedTag=$(echo "${tag}" | tr -cd '[:alnum:]._-')
    if [[ -z "${sanitizedTag}" || "${sanitizedTag}" != "${tag}" ]]; then
      echo "Invalid publish tag: ${tag}"
      exit 1
    fi

    echo "Publishing tag: ${sanitizedTag}"
    npm publish --provenance --tag "${sanitizedTag}"
    curl "https://purge.jsdelivr.net/npm/@zenvor/hls.js@${sanitizedTag}"
    echo "Published."
  fi
else
  echo "Already published."
fi
