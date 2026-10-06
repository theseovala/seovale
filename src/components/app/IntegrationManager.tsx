import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, ExternalLink, ShieldCheck, Activity, KeyRound, Plug, Lock, RotateCcw, Trash2, Copy, ChevronDown } from "lucide-react";
import { Section, StatusBadge, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/seovale-db";
import { INTEGRATIONS, integrationById, authTypeLabel, capabilitiesFor, rateLimitFor } from "@/lib/integrations/registry";
import {
  disconnectIntegration,
  listIntegrationEvents,
  listIntegrations,
  revokeProviderCredentials,
  saveIntegrationAccount,
  getIntegrationOverview,
  saveProviderCredentials,
  startIntegrationOAuth,
  testIntegration,
} from "@/lib/integrations.functions";
import type { IntegrationDefinition } from "@/lib/integrations/registry";

import {
  integrationStatusLabel as statusLabel,
  integrationStatusTone as statusTone,
  integrationOutcomeLabel as outcomeLabel,
  integrationOutcomeTone as outcomeTone,
} from "@/lib/integrations/status";
import { GoogleBusinessSetupGuide, GoogleMapsSetupGuide } from "@/components/app/GoogleSetupGuide";
import { ProviderSetupGuide } from "@/components/app/ProviderSetupGuide";


/** Integration overview — every number is counted from real rows, nothing estimated. */
function IntegrationOverview() {
  const overviewFn = useServerFn(getIntegrationOverview);
  const overview = useQuery({
    queryKey: ["integration_overview"],
    queryFn: () => overviewFn(),
    refetchInterval: 60_000,
  });

  if (overview.isLoading || !overview.data) return null;
  const d = overview.data;
  const tiles = [
    { label: "Connected", value: d.connected },
    { label: "Pending configuration", value: d.pendingConfiguration },
    { label: "Authentication errors", value: d.authErrors },
    { label: "Token expired", value: d.expired },
    { label: "Expiring in 7 days", value: d.expiringSoon },
    { label: "Requires provider approval", value: d.approvalRequired },
    { label: "API errors (24h)", value: d.errors24h },
    { label: "Providers available", value: d.totalProviders },
  ];

  return (
    <Section
      title="Integration overview"
      description="Live counts from stored connections, API logs and the audit trail."
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="card-interactive rounded-lg border border-border p-3">
            <p className="num text-xl font-semibold">{tile.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{tile.label}</p>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <p className="text-xs font-medium text-muted-foreground">Audit log</p>
        {d.auditLog.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No audit entries recorded yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {d.auditLog.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  {entry.action}
                  {entry.target ? ` · ${entry.target}` : ""}
                </span>
                <span className="shrink-0 text-muted-foreground">{relativeTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function openAuthorization(url: string) {
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) window.location.assign(url);
}


type MaskedCredential = {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string | null;
  hint: string | null;
  masked: string | null;
  updatedAt: string | null;
  fromEnvironment: boolean;
};

/** Secure provider configuration: write-only inputs, masked stored values. */
function CredentialPanel({
  definition,
  credentials,
  onChanged,
}: {
  definition: IntegrationDefinition;
  credentials: MaskedCredential[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const saveCredsFn = useServerFn(saveProviderCredentials);
  const revokeCredsFn = useServerFn(revokeProviderCredentials);

  const redirectUri =
    definition.kind === "managed"
      ? `${typeof window === "undefined" ? "" : window.location.origin}/api/public/google-business/callback`
      : `${typeof window === "undefined" ? "" : window.location.origin}/api/public/integrations/callback`;

  const saveCreds = useMutation({
    mutationFn: () => saveCredsFn({ data: { provider: definition.id, values } }),
    onSuccess: (result) => {
      setValues({});
      if (result.verified) toast.success(result.message);
      else toast.message(result.message);
      onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revokeCreds = useMutation({
    mutationFn: () => revokeCredsFn({ data: { provider: definition.id } }),
    onSuccess: () => {
      setValues({});
      toast.success("Stored credentials and tokens deleted");
      onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="mt-3 rounded-lg border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        <Lock className="size-3.5" />
        Provider credentials
        <span className="font-normal">
          {credentials.some((c) => c.masked || c.fromEnvironment) ? "· configured" : "· Not Configured"}
        </span>
        <ChevronDown className={`ml-auto size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {credentials.map((field) => (
              <label key={field.key} className="block">
                <span className="mb-1.5 flex items-center justify-between text-xs font-semibold text-muted-foreground">
                  <span>{field.label}</span>
                  <span className="font-normal">
                    {field.masked
                      ? `${field.secret ? field.masked : field.masked} · updated ${field.updatedAt ? relativeTime(field.updatedAt) : ""}`
                      : field.fromEnvironment
                        ? "set in server secrets"
                        : "Not Configured"}
                  </span>
                </span>
                <input
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={values[field.key] ?? ""}
                  placeholder={field.placeholder ?? (field.masked ? "Enter a new value to rotate" : "")}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
                />
                {field.hint && <span className="mt-1 block text-[11px] text-muted-foreground">{field.hint}</span>}
              </label>
            ))}
          </div>

          <div className="rounded-lg border border-dashed px-3 py-2">
            <p className="text-[11px] font-semibold text-muted-foreground">Authorized redirect URI</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-[11px]">{redirectUri}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(redirectUri);
                  toast.success("Redirect URI copied");
                }}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Register this exact URI in the provider console before authorizing.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={saveCreds.isPending || Object.values(values).every((v) => !v.trim())}
              onClick={() => saveCreds.mutate()}
            >
              {saveCreds.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {credentials.some((c) => c.masked) ? "Rotate & verify" : "Save & verify"}
            </Button>
            {credentials.some((c) => c.masked) && (
              <>
                <Button size="sm" variant="outline" onClick={() => setValues({})} disabled={saveCreds.isPending}>
                  <RotateCcw /> Clear form
                </Button>
                <Button size="sm" variant="ghost" disabled={revokeCreds.isPending} onClick={() => revokeCreds.mutate()}>
                  {revokeCreds.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Revoke credentials
                </Button>
              </>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Values are encrypted on the server before storage. Saved secrets are never sent back to this page — only the last four
            characters are shown.
          </p>
        </div>
      )}
    </div>
  );
}

export function IntegrationManager() {
  const queryClient = useQueryClient();
  const listFn = useServerFn(listIntegrations);
  const eventsFn = useServerFn(listIntegrationEvents);
  const startFn = useServerFn(startIntegrationOAuth);
  const testFn = useServerFn(testIntegration);
  const saveFn = useServerFn(saveIntegrationAccount);
  const disconnectFn = useServerFn(disconnectIntegration);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testingAll, setTestingAll] = useState(false);

  const integrations = useQuery({ queryKey: ["integrations"], queryFn: () => listFn() });
  const events = useQuery({ queryKey: ["integration_events"], queryFn: () => eventsFn() });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get("integration");
    const status = params.get("status");
    if (!provider || !status) return;
    const label = integrationById(provider)?.label ?? provider;
    if (status === "connected") toast.success(`${label} connected and verified`);
    else toast.error(`${label} could not be connected — see the activity log below`);
    window.history.replaceState({}, "", window.location.pathname);
    void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    void queryClient.invalidateQueries({ queryKey: ["integration_events"] });
  }, [queryClient]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    void queryClient.invalidateQueries({ queryKey: ["integration_events"] });
  };

  const connect = useMutation({
    mutationFn: (provider: string) => startFn({ data: { provider, origin: window.location.origin } }),
    onSuccess: (result) => openAuthorization(result.authorizationUrl),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setBusy(null),
  });

  const test = useMutation({
    mutationFn: (provider: string) => testFn({ data: { provider } }),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setBusy(null),
  });

  const save = useMutation({
    mutationFn: ({ provider, accountRef }: { provider: string; accountRef: string }) =>
      saveFn({ data: { provider, accountRef } }),
    onSuccess: (_result, variables) => {
      toast.success("Saved — run Test connection to verify it against the live API");
      refresh();
      setBusy(variables.provider);
      test.mutate(variables.provider);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (provider: string) => disconnectFn({ data: { provider } }),
    onSuccess: () => {
      toast.success("Integration disconnected");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setBusy(null),
  });

  if (integrations.isLoading) {
    return (
      <Section title="Integration manager">
        <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
      </Section>
    );
  }

  if (integrations.isError) {
    return (
      <Section title="Integration manager">
        <EmptyState icon={Plug} title="Could not load integrations" description={(integrations.error as Error).message} />
      </Section>
    );
  }

  const state = new Map((integrations.data?.items ?? []).map((item) => [item.provider, item]));
  const isAdmin = integrations.data?.role !== "member";
  const groups = Array.from(new Set(INTEGRATIONS.map((i) => i.group)));

  return (
    <div className="space-y-4">
      <Section
        title="Integration manager"
        description="Every credential is stored encrypted on the server. Status is only shown after a live API call succeeds."
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={testingAll}
            onClick={async () => {
              setTestingAll(true);
              // Partner-only providers are included so their honest
              // APPROVAL_REQUIRED / UNAVAILABLE state is recorded too.
              const targets = INTEGRATIONS;
              let ok = 0;
              // Outcomes are grouped by the adapter's own code, so an
              // approval-gated provider never reads as a plain failure.
              const byCode = new Map<string, string[]>();
              for (const definition of targets) {
                let code = "PROVIDER_ERROR";
                try {
                  const result = await testFn({ data: { provider: definition.id } });
                  code = result.code ?? (result.ok ? "CONNECTED" : "PROVIDER_ERROR");
                  if (result.ok) ok += 1;
                } catch {
                  code = "PROVIDER_ERROR";
                }
                if (code !== "CONNECTED") byCode.set(code, [...(byCode.get(code) ?? []), definition.label]);
              }
              setTestingAll(false);
              refresh();
              if (byCode.size === 0) toast.success(`All ${ok} integrations verified`);
              else {
                const summary = Array.from(byCode.entries())
                  .map(([code, labels]) => `${outcomeLabel[code] ?? code}: ${labels.length}`)
                  .join(" · ");
                toast.error(`${ok} connected · ${summary}`, {
                  description: Array.from(byCode.entries())
                    .map(([code, labels]) => `${outcomeLabel[code] ?? code} — ${labels.join(", ")}`)
                    .join("\n"),
                });
              }
            }}
          >
            {testingAll ? <Loader2 className="animate-spin" /> : <Activity />} Test all connections
          </Button>
        }
      >
        <div className="flex items-start gap-2.5 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            API keys and tokens never reach the browser. Reconnect a platform whenever you rotate its credentials in the provider
            console.
          </span>
        </div>
      </Section>

      <IntegrationOverview />

      {groups.map((group) => (
        <Section key={group} title={group} bodyClassName="p-0">
          <ul className="divide-y">
            {INTEGRATIONS.filter((i) => i.group === group).map((definition) => {
              const item = state.get(definition.id);
              const status = item?.status ?? "disconnected";
              const pending = busy === definition.id && (connect.isPending || test.isPending || remove.isPending);
              return (
                <li key={definition.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">{definition.label}</p>
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusTone[status]}`}>
                          {statusLabel[status] ?? status}
                        </span>
                        {item?.outcomeCode && item.outcomeCode !== "CONNECTED" && (
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${outcomeTone[item.outcomeCode] ?? "bg-neutral-soft text-muted-foreground"}`}
                            title={`Last live test returned ${item.outcomeCode}`}
                          >
                            {outcomeLabel[item.outcomeCode] ?? item.outcomeCode}
                          </span>
                        )}
                        {!item?.configured && definition.requiredSecrets.length > 0 && (
                          <StatusBadge status="Credentials missing" />
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{definition.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {definition.kind === "manual"
                          ? definition.manualReason
                          : item?.accountLabel
                            ? `Account: ${item.accountLabel}${item.lastTestedAt ? ` · last checked ${relativeTime(item.lastTestedAt)}` : ""}`
                            : item?.configured
                              ? "Not connected yet."
                              : `Add ${definition.requiredSecrets.join(" and ")} before connecting.`}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                        <span>Auth: {authTypeLabel[definition.kind]}</span>
                        <span>
                          Last verified:{" "}
                          {item?.lastCheckedAt ? relativeTime(item.lastCheckedAt) : item?.lastTestedAt ? relativeTime(item.lastTestedAt) : "never"}
                        </span>
                        <span>Last sync: {item?.lastSyncAt ? relativeTime(item.lastSyncAt) : "never"}</span>
                        {item?.latencyMs != null && <span>Latency: {item.latencyMs} ms</span>}
                        <span>
                          Rate limit:{" "}
                          {item?.rateLimit
                            ? `${item.rateLimit.remaining ?? "?"}/${item.rateLimit.limit ?? "?"} left${item.rateLimit.resetAt ? ` · resets ${relativeTime(item.rateLimit.resetAt)}` : ""}`
                            : (rateLimitFor(definition.id) ?? "not published")}
                        </span>
                      </div>
                      {capabilitiesFor(definition.id).length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {capabilitiesFor(definition.id).map((capability) => (
                            <span
                              key={capability}
                              className={`rounded-full border px-2 py-0.5 text-[10px] ${status === "connected" ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground"}`}
                            >
                              {status === "connected" ? "✓ " : ""}
                              {capability}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1.5 text-[11px] text-muted-foreground">No capability is available without provider approval.</p>
                      )}
                      {definition.scopes.length > 0 && (
                        <p className="mt-1 text-[11px] text-muted-foreground">Scopes: {definition.scopes.join(", ")}</p>
                      )}
                      {item?.lastError && <p className="mt-1 text-xs text-negative">{item.lastError}</p>}
                      {item?.tokenExpiresAt && status === "connected" && (
                        <p className="mt-1 text-[11px] text-muted-foreground">Access renews automatically · expires {relativeTime(item.tokenExpiresAt)}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={definition.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3.5" /> API docs
                      </a>
                      {definition.kind === "oauth2" && isAdmin && (
                        <Button
                          size="sm"
                          disabled={!item?.configured || pending}
                          onClick={() => {
                            setBusy(definition.id);
                            connect.mutate(definition.id);
                          }}
                        >
                          {pending && connect.isPending && <Loader2 className="animate-spin" />}
                          {status === "connected" ? "Reconnect" : "Connect"}
                        </Button>
                      )}
                      {definition.kind === "managed" && (
                        <span className="text-xs text-muted-foreground">Managed in Connected platforms</span>
                      )}
                      {definition.kind !== "manual" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setBusy(definition.id);
                            test.mutate(definition.id);
                          }}
                        >
                          {pending && test.isPending ? <Loader2 className="animate-spin" /> : <Activity />}
                          Test connection
                        </Button>
                      )}
                      {isAdmin && definition.kind !== "manual" && definition.kind !== "managed" && item?.status !== "disconnected" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => {
                            setBusy(definition.id);
                            remove.mutate(definition.id);
                          }}
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </div>

                  {isAdmin && definition.id === "google_business" && (
                    <GoogleBusinessSetupGuide
                      credentialsReady={(item?.credentials ?? []).some((c) => c.masked || c.fromEnvironment)}
                    />
                  )}

                  {isAdmin && definition.id === "google_maps" && (
                    <GoogleMapsSetupGuide
                      credentialsReady={(item?.credentials ?? []).some((c) => c.masked || c.fromEnvironment)}
                      verified={status === "connected"}
                      onChanged={refresh}
                    />
                  )}

                  {isAdmin && definition.id !== "google_maps" && (definition.credentialFields?.length ?? 0) > 0 && (
                    <ProviderSetupGuide
                      definition={definition}
                      credentialsReady={(item?.credentials ?? []).some((c) => c.masked || c.fromEnvironment)}
                      verified={status === "connected"}
                      accountRef={item?.accountRef ?? null}
                      onChanged={refresh}
                    />
                  )}

                  {isAdmin && (definition.credentialFields?.length ?? 0) > 0 && (
                    <CredentialPanel
                      definition={definition}
                      credentials={(item?.credentials ?? []) as MaskedCredential[]}
                      onChanged={refresh}
                    />
                  )}


                  {definition.kind === "api_key" && isAdmin && (
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <label className="min-w-[220px] flex-1">
                        <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                          <KeyRound className="mr-1 inline size-3" /> {definition.accountField?.label}
                        </span>
                        <input
                          value={drafts[definition.id] ?? item?.accountRef ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [definition.id]: e.target.value }))}
                          className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
                        />
                        <span className="mt-1 block text-[11px] text-muted-foreground">{definition.accountField?.hint}</span>
                      </label>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={save.isPending}
                        onClick={() => {
                          const value = (drafts[definition.id] ?? item?.accountRef ?? "").trim();
                          if (!value) {
                            toast.error("Enter a value first");
                            return;
                          }
                          save.mutate({ provider: definition.id, accountRef: value });
                        }}
                      >
                        {save.isPending && <Loader2 className="animate-spin" />} Save & verify
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      ))}

      <Section title="Integration activity log" description="Authorization attempts, live tests, token refreshes, expiries and rate limits" bodyClassName="p-0">
        {events.data && events.data.length > 0 ? (
          <ul className="divide-y">
            {events.data.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="text-xs font-semibold">{integrationById(event.provider)?.label ?? event.provider}</span>
                <span className="text-xs text-muted-foreground">{event.event_type.replace(/_/g, " ")}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{event.message}</span>
                {event.http_status && <span className="text-xs text-muted-foreground">HTTP {event.http_status}</span>}
                <span className="text-[11px] text-muted-foreground">{relativeTime(event.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-5">
            <EmptyState icon={Activity} title="No integration activity yet" description="Connection attempts and live API tests will be logged here." />
          </div>
        )}
      </Section>
    </div>
  );
}
