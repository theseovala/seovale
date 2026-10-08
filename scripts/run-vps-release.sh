#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ || "$1" == "0000000000000000000000000000000000000000" ]]; then
  echo "Usage: run-vps-release.sh <full-main-commit-sha>" >&2
  exit 2
fi

repository="/var/www/seovale"
git -C "$repository" fetch origin main
fetched="$(git -C "$repository" rev-parse FETCH_HEAD)"
[[ "$1" == "$fetched" ]] || {
  echo "Refusing a stale webhook: requested commit is not the fetched main head." >&2
  exit 1
}

exec bash /opt/seovale-deploy/deploy-vps.sh --deploy "$1"
