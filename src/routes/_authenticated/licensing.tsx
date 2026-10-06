import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, Loader2, Download, RefreshCw, Copy } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  getLicenseOverview,
  getMfaStatus,
  startMfaEnrollment,
  confirmMfaEnrollment,
  verifyStepUp,
  createLicenseClient,
  createLicense,
  setLicenseStatus,
  renewLicense,
  changeLicenseDomain,
  resetInstallation,
  requestDownload,
  publishRelease,
  rollbackRelease,
  listAdminUsers,
  setAdminRole,
} from "@/lib/license.functions";

export const Route = createFileRoute("/_authenticated/licensing")({
  head: () => ({
    meta: [
      { title: "Licensing & Deployment Control — Seovale" },
      {
        name: "description",
        content:
          "Issue and control Seovale deployment licenses: domain lock, installation binding, signed releases, short-lived downloads, two-factor protected actions and full audit history.",
      },
      { property: "og:title", content: "Licensing & Deployment Control — Seovale" },
      { property: "og:description", content: "License states, domain lock, installations, signed releases and security events." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LicensingPage,
});

const STATUS_TONE: Record<string, string> = {
  active: "bg-positive-soft text-positive",
  pending: "bg-neutral-soft text-muted-foreground",
  suspended: "bg-warning-soft text-rating-foreground",
  expired: "bg-warning-soft text-rating-foreground",
  revoked: "bg-negative-soft text-negative",
  cancelled: "bg-neutral-soft text-muted-foreground",
  transfer_pending: "bg-neutral-soft text-muted-foreground",
};

const when = (value?: string | null) => (value ? new Date(value).toLocaleString() : "—");

function LicensingPage() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["license-overview"], queryFn: () => getLicenseOverview(), refetchInterval: 60_000 });
  const mfa = useQuery({ queryKey: ["license-mfa"], queryFn: () => getMfaStatus() });

  const [pendingAction, setPendingAction] = useState<{ action: string; run: () => void } | null>(null);
  const [stepUpCode, setStepUpCode] = useState("");
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string; recoveryCodes: string[] } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [clientName, setClientName] = useState("");
  const [newLicense, setNewLicense] = useState({ clientId: "", domain: "", expiresAt: "" });
  const [issued, setIssued] = useState<{ licenseKey: string; licenseSecret: string; domain: string } | null>(null);
  const [domainEdit, setDomainEdit] = useState<Record<string, string>>({});
  const [releaseForm, setReleaseForm] = useState({ version: "", buildId: "", artifactPath: "" });
  const [roleForm, setRoleForm] = useState({ email: "", role: "developer" });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["license-overview"] });
    queryClient.invalidateQueries({ queryKey: ["license-mfa"] });
  };

  /** Any sensitive call may demand step-up; we surface the code prompt and retry. */
  const handleError = (error: Error, retry: () => void) => {
    const match = /^STEP_UP_REQUIRED:(.+)$/.exec(error.message);
    if (match) {
      setPendingAction({ action: match[1]!, run: retry });
      return;
    }
    toast.error(error.message);
  };

  // Sensitive licence actions are expensive and audited, so a second click
  // while one is in flight is ignored rather than queued.
  const [busy, setBusy] = useState(false);
  const run = <T,>(fn: () => Promise<T>, success: string) => {
    if (busy) return;
    setBusy(true);
    const attempt = () =>
      fn()
        .then(() => {
          toast.success(success);
          setPendingAction(null);
          setStepUpCode("");
          refresh();
          setBusy(false);
        })
        .catch((error: Error) => {
          setBusy(false);
          handleError(error, attempt);
        });
    attempt();
  };

  const stepUp = useMutation({
    mutationFn: () => verifyStepUp({ data: { action: pendingAction!.action, code: stepUpCode } }),
    onSuccess: () => {
      const retry = pendingAction?.run;
      setStepUpCode("");
      retry?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const enroll = useMutation({
    mutationFn: () => startMfaEnrollment(),
    onSuccess: (data) => setEnrollment(data),
    onError: (error: Error) => toast.error(error.message),
  });
  const confirmEnroll = useMutation({
    mutationFn: () => confirmMfaEnrollment({ data: { code: enrollCode } }),
    onSuccess: () => {
      toast.success("Two-factor authentication is active.");
      setEnrollment(null);
      setEnrollCode("");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const admins = useQuery({
    queryKey: ["license-admins"],
    queryFn: () => listAdminUsers(),
    retry: false,
    enabled: Boolean(overview.data?.isStaff),
  });

  const data = overview.data;
  const releases = data?.releases ?? [];
  const publishedRelease = useMemo(() => releases.find((r: any) => r.status === "published"), [releases]);

  if (overview.isLoading) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 p-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading licensing…
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Licensing & deployment control"
        description="Every licence decision is enforced on the server. Sensitive actions need an authenticator code."
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        }
      />

      <div className="space-y-6">
        {/* ---------- two-factor ---------- */}
        <Section title="Two-factor authentication" description="Required before any licence, domain, installation, release or download action.">
          <div className="flex flex-wrap items-center gap-3">
            <Badge className={mfa.data?.confirmed ? STATUS_TONE["active"] : STATUS_TONE["pending"]}>
              {mfa.data?.confirmed ? "Active" : "Not set up"}
            </Badge>
            <span className="text-sm text-muted-foreground">Last used {when(mfa.data?.lastUsedAt)}</span>
            {!mfa.data?.confirmed && !enrollment && (
              <Button size="sm" onClick={() => enroll.mutate()} disabled={enroll.isPending}>
                <ShieldCheck className="mr-2 h-4 w-4" /> Set up authenticator
              </Button>
            )}
          </div>
          {enrollment && (
            <div className="mt-4 space-y-3 rounded-lg border border-border/60 p-4">
              <p className="text-sm">Add this key to your authenticator app, then enter the 6-digit code.</p>
              <code className="block break-all rounded bg-muted px-3 py-2 text-sm">{enrollment.secret}</code>
              <p className="text-sm text-muted-foreground">
                Recovery codes (stored only as hashes — save them now): {enrollment.recoveryCodes.join(", ")}
              </p>
              <div className="flex gap-2">
                <Input value={enrollCode} onChange={(e) => setEnrollCode(e.target.value)} placeholder="123456" className="max-w-[160px]" />
                <Button size="sm" onClick={() => confirmEnroll.mutate()} disabled={confirmEnroll.isPending}>
                  Confirm
                </Button>
              </div>
            </div>
          )}
        </Section>

        {/* ---------- step-up prompt ---------- */}
        {pendingAction && (
          <Section title="Confirm with your authenticator" description={`This step is required for: ${pendingAction.action.replace(/_/g, " ")}.`}>
            <div className="flex flex-wrap gap-2">
              <Input value={stepUpCode} onChange={(e) => setStepUpCode(e.target.value)} placeholder="6-digit code" className="max-w-[160px]" />
              <Button size="sm" onClick={() => stepUp.mutate()} disabled={stepUp.isPending || stepUpCode.length < 6}>
                Confirm and continue
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingAction(null)}>
                Cancel
              </Button>
            </div>
          </Section>
        )}

        {/* ---------- admin: clients + issue licence ---------- */}
        {data?.isStaff && (
          <>
            <Section title="Client companies" description={`${data.clients.length} client${data.clients.length === 1 ? "" : "s"} on record.`}>
              <div className="flex flex-wrap gap-2">
                <Input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client company name" className="max-w-[260px]" />
                <Button
                  size="sm"
                  onClick={() => run(() => createLicenseClient({ data: { name: clientName } }).then(() => setClientName("")), "Client created.")}
                  disabled={clientName.trim().length < 2}
                >
                  Add client
                </Button>
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {data.clients.map((client: any) => (
                  <li key={client.id} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                    <span>{client.name}</span>
                    <span className="text-muted-foreground">{client.contact_email ?? "no contact email"}</span>
                  </li>
                ))}
                {!data.clients.length && <EmptyState icon={KeyRound} title="No clients yet" description="Add a client before issuing a licence." />}
              </ul>
            </Section>

            <Section title="Issue a licence" description="A licence is bound to one authorized domain and generates a one-time deployment secret.">
              <div className="grid gap-3 md:grid-cols-4">
                <div>
                  <Label className="text-xs">Client</Label>
                  <select
                    className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
                    value={newLicense.clientId}
                    onChange={(e) => setNewLicense({ ...newLicense, clientId: e.target.value })}
                  >
                    <option value="">Select a client</option>
                    {data.clients.map((client: any) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Authorized domain</Label>
                  <Input className="mt-1" value={newLicense.domain} onChange={(e) => setNewLicense({ ...newLicense, domain: e.target.value })} placeholder="clientdomain.com" />
                </div>
                <div>
                  <Label className="text-xs">Expiry (optional)</Label>
                  <Input className="mt-1" type="date" value={newLicense.expiresAt} onChange={(e) => setNewLicense({ ...newLicense, expiresAt: e.target.value })} />
                </div>
                <div className="flex items-end">
                  <Button
                    size="sm"
                    disabled={!newLicense.clientId || newLicense.domain.trim().length < 3}
                    onClick={() =>
                      run(
                        () =>
                          createLicense({
                            data: {
                              clientId: newLicense.clientId,
                              domain: newLicense.domain,
                              expiresAt: newLicense.expiresAt ? new Date(`${newLicense.expiresAt}T23:59:59Z`).toISOString() : null,
                            },
                          }).then((result) => {
                            setIssued(result);
                            setNewLicense({ clientId: "", domain: "", expiresAt: "" });
                          }),
                        "Licence issued.",
                      )
                    }
                  >
                    <KeyRound className="mr-2 h-4 w-4" /> Issue licence
                  </Button>
                </div>
              </div>
              {issued && (
                <div className="mt-4 rounded-lg border border-border/60 p-4 text-sm">
                  <p className="font-medium">Licence {issued.licenseKey} for {issued.domain}</p>
                  <p className="mt-1 text-muted-foreground">
                    Deployment secret (shown once, store it in the client deployment's environment):
                  </p>
                  <code className="mt-1 block break-all rounded bg-muted px-3 py-2">{issued.licenseSecret}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => {
                      navigator.clipboard.writeText(issued.licenseSecret);
                      toast.success("Secret copied.");
                    }}
                  >
                    <Copy className="mr-2 h-4 w-4" /> Copy secret
                  </Button>
                </div>
              )}
            </Section>
          </>
        )}

        {/* ---------- licences ---------- */}
        <Section title={data?.isStaff ? "Licences" : "Your licence"} description="Status, authorized domain, installations and available actions.">
          {!data?.licenses.length ? (
            <EmptyState icon={KeyRound} title="No licences" description="No licence is associated with this account yet." />
          ) : (
            <div className="space-y-4">
              {data.licenses.map((license: any) => (
                <div key={license.id} className="rounded-lg border border-border/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{license.license_key}</p>
                      <p className="text-sm text-muted-foreground">
                        {data.clients.find((c: any) => c.id === license.client_id)?.name ?? "Unknown client"} · domain{" "}
                        {license.domains.find((d: any) => d.status === "active")?.domain ?? "none"}
                      </p>
                    </div>
                    <Badge className={STATUS_TONE[license.status] ?? STATUS_TONE["pending"]}>{license.status.replace(/_/g, " ")}</Badge>
                  </div>

                  <dl className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3 lg:grid-cols-5">
                    <div><dt>Created</dt><dd className="text-foreground">{when(license.created_at)}</dd></div>
                    <div><dt>Activated</dt><dd className="text-foreground">{when(license.activated_at)}</dd></div>
                    <div><dt>Expires</dt><dd className="text-foreground">{when(license.expires_at)}</dd></div>
                    <div><dt>Last validation</dt><dd className="text-foreground">{when(license.last_validated_at)}</dd></div>
                    <div><dt>Last download</dt><dd className="text-foreground">{when(license.last_download_at)}</dd></div>
                  </dl>
                  <p className="mt-2 text-xs text-muted-foreground">Features: {license.features.join(", ")}</p>

                  <div className="mt-3 space-y-1 text-xs">
                    <p className="font-medium text-foreground">Installations ({license.installations.length})</p>
                    {license.installations.length === 0 && <p className="text-muted-foreground">No deployment has registered yet.</p>}
                    {license.installations.map((installation: any) => (
                      <div key={installation.id} className="flex flex-wrap items-center gap-2 rounded border border-border/50 px-2 py-1">
                        <span className="font-mono">{installation.installation_ref}</span>
                        <span className="text-muted-foreground">{installation.domain}</span>
                        <Badge className={installation.status === "active" ? STATUS_TONE["active"] : STATUS_TONE["pending"]}>{installation.status}</Badge>
                        <span className="text-muted-foreground">validated {when(installation.last_validated_at)}</span>
                        {data.isStaff && installation.status === "active" && (
                          <Button size="sm" variant="ghost" onClick={() => run(() => resetInstallation({ data: { installationId: installation.id } }), "Installation reset.")} disabled={busy}>
                            Reset
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {data.isStaff && license.status !== "active" && license.status !== "revoked" && (
                      <Button size="sm" onClick={() => run(() => setLicenseStatus({ data: { licenseId: license.id, status: "active" } }), "Licence activated.")} disabled={busy}>
                        Activate
                      </Button>
                    )}
                    {data.isStaff && license.status === "active" && (
                      <Button size="sm" variant="outline" onClick={() => run(() => setLicenseStatus({ data: { licenseId: license.id, status: "suspended" } }), "Licence suspended.")} disabled={busy}>
                        Suspend
                      </Button>
                    )}
                    {data.isStaff && license.status !== "revoked" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run(() => setLicenseStatus({ data: { licenseId: license.id, status: "revoked", reason: "Revoked from admin panel" } }), "Licence revoked.")}
                       disabled={busy}>
                        Revoke
                      </Button>
                    )}
                    {data.isStaff && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          run(
                            () => renewLicense({ data: { licenseId: license.id, expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() } }),
                            "Licence renewed for one year.",
                          )
                        }
                      >
                        Renew 1 year
                      </Button>
                    )}
                    {publishedRelease && license.status === "active" && (
                      <Button
                        size="sm"
                        onClick={() =>
                          run(
                            () =>
                              requestDownload({ data: { licenseId: license.id, releaseId: publishedRelease.id } }).then((result) => {
                                window.location.href = result.url;
                              }),
                            "Download authorized.",
                          )
                        }
                       disabled={busy}>
                        <Download className="mr-2 h-4 w-4" /> Download package {publishedRelease.version}
                      </Button>
                    )}
                  </div>

                  {data.isStaff && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Input
                        className="max-w-[220px]"
                        placeholder="new-domain.com"
                        value={domainEdit[license.id] ?? ""}
                        onChange={(e) => setDomainEdit({ ...domainEdit, [license.id]: e.target.value })}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(domainEdit[license.id] ?? "").length < 3}
                        onClick={() => run(() => changeLicenseDomain({ data: { licenseId: license.id, domain: domainEdit[license.id]! } }), "Domain changed.")}
                      >
                        Change domain
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ---------- releases ---------- */}
        <Section title="Releases" description="Only signed packages that passed artifact inspection can be downloaded.">
          {data?.isStaff && (
            <div className="mb-4 grid gap-2 md:grid-cols-4">
              <Input
                placeholder="Version (1.0.0)"
                value={releaseForm.version}
                onChange={(e) => setReleaseForm({ ...releaseForm, version: e.target.value })}
              />
              <Input
                placeholder="Build id"
                value={releaseForm.buildId}
                onChange={(e) => setReleaseForm({ ...releaseForm, buildId: e.target.value })}
              />
              <Input
                placeholder="Artifact path in release storage"
                value={releaseForm.artifactPath}
                onChange={(e) => setReleaseForm({ ...releaseForm, artifactPath: e.target.value })}
              />
              <Button
                variant="outline"
                disabled={!releaseForm.version || !releaseForm.buildId || !releaseForm.artifactPath}
                onClick={() =>
                  run(
                    () => publishRelease({ data: { ...releaseForm } }),
                    "Release inspected, signed and published.",
                  )
                }
              >
                Publish release
              </Button>
            </div>
          )}
          {!releases.length ? (
            <EmptyState icon={KeyRound} title="No releases yet" description="Package and publish a build to make it downloadable." />
          ) : (
            <div className="space-y-2 text-sm">
              {releases.map((release: any) => (
                <div key={release.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                  <div>
                    <p className="font-medium">
                      {release.version} <span className="font-mono text-xs text-muted-foreground">{release.release_ref}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">build {release.build_id} · checksum {release.checksum_sha256.slice(0, 16)}…</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={release.inspection_passed ? STATUS_TONE["active"] : STATUS_TONE["revoked"]}>
                      {release.inspection_passed ? "Inspection passed" : "Inspection failed"}
                    </Badge>
                    <Badge className={release.signed ? STATUS_TONE["active"] : STATUS_TONE["pending"]}>{release.signed ? "Signed" : "Unsigned"}</Badge>
                    <Badge className={release.status === "published" ? STATUS_TONE["active"] : STATUS_TONE["pending"]}>{release.status}</Badge>
                    {data?.isStaff && release.status === "published" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run(() => rollbackRelease({ data: { releaseId: release.id } }), "Release rolled back.")}
                      >
                        Roll back
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ---------- downloads ---------- */}
        <Section title="Download history" description="Every authorization and download attempt is recorded.">
          {!data?.downloads.length ? (
            <EmptyState icon={KeyRound} title="No downloads yet" description="Authorized downloads will appear here." />
          ) : (
            <div className="space-y-1 text-sm">
              {data.downloads.map((event: any) => (
                <div key={event.id} className="flex flex-wrap justify-between gap-2 rounded border border-border/50 px-3 py-1.5">
                  <span>{event.result.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">{event.reason ?? ""}</span>
                  <span className="text-muted-foreground">{when(event.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ---------- events ---------- */}
        <Section title="Licence audit history" description="Who did what, when — no secrets are ever stored in these records.">
          {!data?.events.length ? (
            <EmptyState icon={KeyRound} title="No events yet" description="Licence activity will appear here." />
          ) : (
            <div className="space-y-1 text-sm">
              {data.events.map((event: any) => (
                <div key={event.id} className="flex flex-wrap justify-between gap-2 rounded border border-border/50 px-3 py-1.5">
                  <span>{event.event_type.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">{event.resource ?? ""}</span>
                  <span className="text-muted-foreground">{when(event.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {data?.isStaff && admins.data?.allowed && (
          <Section title="Access control" description="Who holds an administrative role. Granting or removing a role is recorded as a critical security event.">
            <div className="space-y-1 text-sm">
              {admins.data.entries.map((entry: any) => (
                <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 px-3 py-1.5">
                  <span className="font-medium">{entry.email ?? entry.user_id}</span>
                  <Badge variant="outline">{entry.role.replace(/_/g, " ")}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      run(() => setAdminRole({ data: { email: entry.email, role: entry.role, grant: false } }), "Role removed.")
                    }
                    disabled={!entry.email}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <Label htmlFor="role-email">Account email</Label>
                <Input id="role-email" value={roleForm.email} onChange={(e) => setRoleForm((f) => ({ ...f, email: e.target.value }))} placeholder="person@company.com" />
              </div>
              <div>
                <Label htmlFor="role-name">Role</Label>
                <select
                  id="role-name"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={roleForm.role}
                  onChange={(e) => setRoleForm((f) => ({ ...f, role: e.target.value }))}
                >
                  {["owner", "super_admin", "security_admin", "tech_lead", "developer", "qa", "support"].map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                onClick={() =>
                  run(() => setAdminRole({ data: { email: roleForm.email.trim(), role: roleForm.role as any, grant: true } }), "Role granted.")
                }
                disabled={!roleForm.email.trim()}
              >
                Grant role
              </Button>
            </div>
          </Section>
        )}

        {data?.isStaff && (
          <Section title="Licence security events" description="Denied and suspicious attempts recorded by the licence authority.">
            {!data.securityEvents.length ? (
              <EmptyState icon={KeyRound} title="No security events" description="Nothing has been denied so far." />
            ) : (
              <div className="space-y-1 text-sm">
                {data.securityEvents.map((event: any) => (
                  <div key={event.id} className="flex flex-wrap justify-between gap-2 rounded border border-border/50 px-3 py-1.5">
                    <span className="font-medium">{event.event_type.replace(/_/g, " ")}</span>
                    <span className="text-muted-foreground">{event.message}</span>
                    <span className="text-muted-foreground">{when(event.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}
      </div>
    </AppShell>
  );
}
