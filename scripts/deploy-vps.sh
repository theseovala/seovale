#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--deploy" || ! "$2" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: scripts/deploy-vps.sh --deploy <full-commit-sha>" >&2
  exit 2
fi

commit="$2"
repository="/var/www/seovale"
release="/var/www/seovale-releases/$commit"
override="/etc/systemd/system/seovale.service.d/release.conf"
state="/var/lib/seovale-deploy"
export PATH="/root/.bun/bin:$PATH"
mkdir -p "$state" "$(dirname "$release")" "$(dirname "$override")"
exec 9>"$state/lock"
flock -n 9 || { echo "Another deployment is running." >&2; exit 1; }

git -C "$repository" cat-file -e "$commit^{commit}"
git -C "$repository" diff --quiet
git -C "$repository" diff --cached --quiet
test -f "$repository/.env.local"
if [[ -e "$release" ]]; then
  echo "Release path already exists; refusing to overwrite it: $release" >&2
  exit 1
fi
git -C "$repository" worktree add --detach "$release" "$commit"
ln -s "$repository/.env.local" "$release/.env.local"
cd "$release"
bun install --frozen-lockfile
bun x tsc --noEmit
bun test

# A fixture test cannot satisfy the production Google-review acceptance gate.
bun -e '
  import { resolveGoogleMapsUrl, scanGooglePlace } from "./src/lib/google-places.server.ts";
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not configured.");
  const place = await resolveGoogleMapsUrl("https://www.google.com/maps/place/Googleplex/", key);
  const snapshot = await scanGooglePlace(place.placeId, key);
  if (!snapshot.reviews.length) throw new Error("Google returned no live review records.");
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", "1600 Amphitheatre Pkwy, Mountain View, CA");
  url.searchParams.set("key", key);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok || result.status !== "OK" || !result.results?.length) {
    throw new Error(`Geocoding deployment gate failed (${result.status ?? response.status}): ${result.error_message ?? "No location returned"}`);
  }
  console.log(`Google live gate passed: ${snapshot.placeId}, ${snapshot.reviews.length} records.`);
'
NITRO_PRESET=node-server bun run build
test -f "$release/.output/server/index.mjs"
printf '{"commit":"%s"}\n' "$commit" > "$release/.output/seovale-release.json"

had_override=false
if [[ -f "$override" ]]; then
  cp -p "$override" "$state/previous-release.conf"
  had_override=true
fi
switched=false
rollback() {
  code=$?
  trap - EXIT
  if [[ $code -ne 0 && "$switched" == true ]]; then
    if [[ "$had_override" == true ]]; then
      cp -p "$state/previous-release.conf" "$override"
    else
      rm -f "$override"
    fi
    systemctl daemon-reload
    systemctl restart seovale
    curl --fail --silent --show-error --max-time 20 http://127.0.0.1:3000/ >/dev/null
    echo "Deployment failed; previous service configuration restored." >&2
  fi
  exit "$code"
}
trap rollback EXIT
candidate="$state/candidate-release.conf"
printf '[Service]\nWorkingDirectory=%s\nExecStart=\nExecStart=/usr/bin/node %s/.output/server/index.mjs\nEnvironment=SEOVALE_DEPLOYED_COMMIT=%s\n' \
  "$release" "$release" "$commit" > "$candidate"
chmod 644 "$candidate"
switched=true
cp "$candidate" "$override"
systemctl daemon-reload
systemctl restart seovale

healthy=false
for attempt in {1..20}; do
  if systemctl is-active --quiet seovale &&
    curl --fail --silent --show-error --max-time 5 -D "$state/health-headers" \
      http://127.0.0.1:3000/ -o /dev/null &&
    grep -qi "^x-seovale-commit: $commit" "$state/health-headers"; then
    healthy=true
    break
  fi
  sleep 2
done
[[ "$healthy" == true ]] || { echo "Release health/commit verification failed." >&2; exit 1; }
printf '%s\n' "$commit" > "$state/current-commit"
echo "Deployment verified: $commit"
