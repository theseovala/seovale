# Seovale — Enterprise Architecture

Living documentation of the real production architecture. No mock, fake or simulated components exist anywhere in this system; every external call hits the provider's documented API.

## 1. System architecture

```
Frontend (TanStack Start, React 19, SSR)
        │  typed RPC (createServerFn) / server routes (src/routes/api/**)
        ▼
Authentication (Lovable Auth) → Authorization (workspace role, checked server-side)
        ▼
Service layer (src/lib/**.server.ts — never imported by client code)
        ▼
Integration gateway (src/lib/integrations/providers.server.ts)
        ▼
Provider adapters (one per provider, only documented methods)
        ▼
Real provider APIs  → validation → database → audit/event system → UI update
```

- Client code imports only `*.functions.ts` server functions and the client-safe registry (`src/lib/integrations/registry.ts`). Secrets never leave the server.
- Long-running and external-event work goes through the durable job queue (`src/lib/jobs.server.ts`, table `integration_sync_jobs`): pending → processing → completed / failed / retrying / cancelled, with lease-based single flight, exponential backoff (capped at 1 hour), dead-letter after `max_attempts`, and idempotency keys that prevent duplicate work.

## 2. Entity relationships

```
User (auth.users)
 → platform_admins (super_admin — granted only by the backend/service role)
 → Workspace (tenant boundary; kind: agency | client | business, optional parent_workspace_id)
    → workspace_members: owner | admin | member
    → integration_connections / integration_provider_credentials (encrypted, service-role only)
    → provider accounts (account_ref on the connection)
    → sync jobs → API logs → stored data (reviews, alerts…) → audit logs
Business/Location → Reviews → sentiment/AI analysis → replies → publishing
Business/Location → SEO projects → domains → keywords → rankings → competitors → audits
```

### Authorization model (RBAC)

| Level | Where it lives | Grants |
| --- | --- | --- |
| Super Admin | `platform_admins` (no INSERT policy — service role only) | every workspace |
| Agency | workspace with `kind = 'agency'`; child clients/businesses point at it via `parent_workspace_id` | owner/admin of the agency reach all descendant workspaces |
| Client / Business | workspace with `kind = 'client' | 'business'` | only its own members |
| Member roles | `workspace_members.role` (owner/admin/member) | member = read/write in that workspace; owner/admin additionally gate privileged actions |

Every policy in `public` resolves through two security-definer helpers, so isolation is defined in exactly one place:

- `private.is_workspace_member(workspace_id [, user_id])` — super admin, direct member, or owner/admin of an ancestor workspace (`private.workspace_lineage`).
- `private.has_workspace_role(workspace_id, roles[] [, user_id])` — same, restricted to the listed roles.

`workspaces.parent_workspace_id` is guarded by `public.assert_workspace_hierarchy()` (no self-parent, no cycles, max depth 10). A client can never reach a sibling client: its lineage only walks upward, never sideways or downward.

Cross-tenant isolation is enforced twice: RLS uses the helpers above on every read, and every server function resolves the caller's workspace from the authenticated session (`requireSupabaseAuth`), never from client input.


## 3. Database schema (public)

Core (pre-existing): workspaces, workspace_members, profiles, connected_platforms, reviews, alerts, reports, removal_cases/removal_scans, removal_scan_settings, google_business_connections, integration_connections, integration_oauth_states, integration_events, integration_provider_credentials, scheduler_tokens.

Enterprise foundation (2026-09-21 migration):

| Table | Purpose |
| --- | --- |
| `integration_sync_jobs` | durable queue: status, priority, attempts/max, next_attempt_at, lease_expires_at, idempotency (unique partial index) |
| `integration_webhook_events` | raw provider events: signature_valid, payload, dedupe by provider_event_id |
| `integration_api_logs` | every real provider call: operation, HTTP status, outcome code, error |
| `integration_usage` | usage metrics **only** when the provider API reports them (`source: api_response`) |
| `integration_rate_limits` | rate-limit state read from provider response headers/bodies |
| `integration_health` | latest real test outcome and latency per provider |
| `audit_logs` | security-relevant actions with actor, target, metadata |

All are workspace-scoped with RLS (members read their own workspace; writes go through the backend service role). `integration_provider_credentials`, `integration_connections`, `integration_oauth_states` and `scheduler_tokens` deliberately have no client policies — they are service-role only.

## 4. Integration architecture

Provider catalogue: `src/lib/integrations/registry.ts` — 26 providers across Google, Meta, review sites, community, SEO, AI, communication and payments groups. Each definition carries kind (`oauth2 | api_key | managed | manual`), scopes, docs URL, credential fields and — where honest — `approvalRequired` / `manualReason`.

Standard adapter contract (`src/lib/integrations/providers.server.ts`):

- `providerConfigured(id, creds)` — vault credentials win over environment fallback.
- `buildAuthorizationUrl / exchangeCode / refreshAccessToken` — real OAuth 2.0 (PKCE where the provider requires it; Meta long-lived token exchange).
- `testIntegration` / `testApiKeyProvider` — one real documented endpoint per provider; results carry a standardized `code`: `CONNECTED`, `NOT_CONFIGURED`, `INVALID_CREDENTIALS`, `AUTHENTICATION_FAILED`, `INSUFFICIENT_SCOPE`, `RATE_LIMITED`, `PROVIDER_ERROR`, `APPROVAL_REQUIRED`, `TOKEN_EXPIRED`, `UNAVAILABLE`.
- Providers with partner-only APIs (Indeed, Glassdoor) are honestly `UNAVAILABLE`; Google Ads reports `APPROVAL_REQUIRED` until a developer token is granted.

Credential vault: `integration_provider_credentials` — AES-GCM encrypted per field, service-role only, masked hints to the browser, rotate/revoke from the Integration Manager, all actions audited.

## 5. OAuth flow

`startIntegrationOAuth` → encrypted state + PKCE verifier stored server-side → provider consent → `/api/public/integrations/callback` → state hash check → token exchange → encrypted token storage → live API call to verify. Refresh happens transparently before any authenticated call; expiry without a refresh token marks the connection `expired`.

## 6. Webhook flow

`/api/public/integrations/webhook?provider=meta|twitter|trustpilot`:

1. Meta subscription handshake (`hub.verify_token` via `META_WEBHOOK_VERIFY_TOKEN`).
2. Signature verification (Meta `x-hub-signature-256`, X `x-twitter-webhooks-signature`, Trustpilot `tp-signature`) — unverified payloads are stored as `rejected` and refused with 401.
3. Deduplication by provider event id (unique partial index → repeated deliveries return `duplicate`).
4. Workspace resolution from the connected account ref; unmatched events are honestly `rejected`.
5. Inline processing with a durable job enqueued first — retries go to the queue with backoff.

Queue runner: `/api/public/integrations/jobs-run` (token-authenticated; hourly pg_cron backstop `seovale-integration-jobs`, 24 runs/day — fresh webhooks are processed on arrival, the runner only handles retries).

## 7. Security model

- RLS on every public table; workspace membership checked in policy and again server-side.
- Roles live in `workspace_members` (owner/admin/member) — server-side checks only; frontend role values are never trusted.
- OAuth state validation with hashed, expiring, encrypted state records.
- Secrets: server-side env or encrypted vault only. Never in code, logs, URLs, or API responses. Masked hints (last 4) are the maximum ever returned.
- Webhook signature verification with timing-safe comparison; replay protection via event dedupe.
- Audit: `integration_events` (connection lifecycle) + `audit_logs` (security actions) + `integration_api_logs` (provider calls).

## 8. AI architecture

Provider-independent layer with fallback routing: Lovable AI Gateway (`openai/gpt-6-astra`) → direct OpenAI → Anthropic. Every AI run is recorded in `ai_runs` with provider, model and outcome. Missing credentials surface "AI provider not configured" — never a fabricated answer.

## 9. Failure handling

Every provider call maps failure to a meaningful, user-visible state: timeout/network → `PROVIDER_ERROR`; 401 → `AUTHENTICATION_FAILED`; 403 → `INVALID_CREDENTIALS`/`INSUFFICIENT_SCOPE`; 429 → `RATE_LIMITED` (logged as warning, never retried immediately); 5xx → `PROVIDER_ERROR`. No failure is ever converted into a success state.

## 10. Testing strategy

- Live Test Connection performs a real provider request per platform.
- Where credentials are missing, flows are tested up to the provider boundary and reported `NOT_CONFIGURED`.
- Queue behavior (idempotency, retry, dead-letter) is verifiable via `integration_sync_jobs`; webhook security via `integration_webhook_events`.
- Status reporting always separates: REAL + VERIFIED / NOT CONFIGURED / REQUIRES APPROVAL / FAILED / NOT TESTABLE.

## 11. Scan engine (current core product)

Flow: URL → `scans` row (queued) → `runScan` → parallel real collectors → RAW `scan_sources`
(+ `provider_raw_data` when a named provider answered) → NORMALIZED `scan_metrics` →
ANALYSIS `scan_findings` → AI analysis over verified findings only → REPORT `scan_reports` → CSV export.

Layers are never mixed: raw provider payloads, normalized measurements, analysis findings and report
output live in separate tables and are always traceable back to the source that produced them.

Collectors (all real network calls, documented public endpoints):

| Source | Provider | Freshness TTL |
| --- | --- | --- |
| `http` | site itself | 60 min |
| `tls` | site itself | 12 h |
| `dns` | Cloudflare DoH | 6 h |
| `rdap` | rdap.org | 24 h |
| `crawl_directives` | site robots.txt/sitemap | 12 h |
| `pagespeed` | Google PageSpeed Insights (API key required) | 12 h |

- **Scan health**: every contacted source is listed with status, error text and freshness
  (`fresh`/`stale`/`expired`/`unavailable`). A missing key reads `NOT_CONFIGURED`, never a guess.
  One failed source never stops the scan.
- **Incremental + resume**: a source already completed and still fresh for the same scan is reused
  instead of refetched; an interrupted scan resumes from its stored sources. Statuses:
  `queued`, `running`, `completed`, `failed`, `cancelled`.
- **Recovery**: the hourly queue runner picks up scans stuck in queued/running for over 15 minutes,
  respects `attempts`/`max_attempts` and dead-letters beyond the limit.
- **Evidence engine**: every finding stores category, code, severity, impact, recommendation,
  source and an evidence object with the measurement and collection timestamp; the UI exposes it
  under each finding.
- **Historical comparison**: the previous completed scan of the same domain produces
  resolved / new / unchanged finding sets from stored data only.
- **AI**: runs through the existing provider-independent AI layer over verified findings only, and
  is instructed to write "Data unavailable" for anything not measured. A failed AI call is recorded
  as a failed `ai_analysis` source — output is never fabricated.
- **Score**: 100 minus the impact of findings that were actually measured; `null` when nothing could
  be measured (the UI shows "Score unavailable", never a placeholder number).
- **Retention**: `deleteScan` removes the scan and its derived findings, metrics, sources, report and
  raw provider payloads, and writes a `scan.deleted` audit record. Unrelated records are untouched.
