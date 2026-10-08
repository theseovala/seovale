# SEO Vale

Repository: https://github.com/theseovala/seovale

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://seovale.com

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/3909161c-29f3-4466-a802-1204f20720c3).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Use the committed Bun lockfile. Production currently uses Node 22 and Bun.

```sh
git clone https://github.com/theseovala/seovale.git
cd seovale
bun install --frozen-lockfile
bun run dev
```

## Google Maps URL scanner

The Review Center accepts Google Maps listing, place, query, search, coordinate,
and redirected/share URLs. Places API (New) resolves the place and retrieves
public place details; Geocoding supports address/coordinate fallback. A URL must
contain or resolve to enough information to identify a location. There is no
Business Profile, owner OAuth, or manual Place ID requirement.

Google selects up to five public review excerpts; the API does not provide the
entire review history. Empty or unusable review responses fail explicitly.
Review/report links come from Google response fields. A report action is shown
only when Google supplies a supported `flagContentUri`.

Google review content is excluded from reply drafting, feedback analysis,
reputation-report AI prompts, and manual/scheduled AI removal scans.

Run `bun test` and `bun x tsc --noEmit`. Unit fixtures are not proof of live
production access. Use `NITRO_PRESET=node-server bun run build` on the VPS.

## Integration job recovery

Workers finalize only their current, unexpired lease and attempt. Due jobs with
expired processing leases can be reclaimed; exhausted attempts are marked failed
with an explicit error instead of being retried indefinitely. Active leases and
completed or cancelled jobs are not reclaimed.

## Safe VPS releases

[scripts/deploy-vps.sh](scripts/deploy-vps.sh) stages a full commit in an isolated
release worktree, uses locked dependencies, and runs tests and a real Google
review/Geocoding gate before changing the running service. Build or API failure
leaves the active service untouched. Service health failure restores the prior
systemd override. Prior releases are retained; no checkout reset or source
cleanup occurs.

The legacy untracked VPS webhook script must not be used: it contains a hard
reset. Install/review the safe release workflow before enabling automatic
deployment. Invoke it only with a fetched, verified full commit SHA:

```sh
bash scripts/deploy-vps.sh --deploy <full-commit-sha>
```

Successful releases expose `x-seovale-commit` for runtime provenance checks.
