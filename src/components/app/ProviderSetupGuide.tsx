import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, ChevronDown, Copy, ExternalLink, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  saveIntegrationAccount,
  saveProviderCredentials,
  startIntegrationOAuth,
  testIntegration,
} from "@/lib/integrations.functions";
import type { IntegrationDefinition } from "@/lib/integrations/registry";

type ConsoleStep = { title: string; detail: string; link?: { href: string; label: string }; showRedirectUri?: boolean };

/** Plain-language console steps per provider, written from each provider's own documentation. */
const CONSOLE_STEPS: Record<string, ConsoleStep[]> = {
  facebook: [
    {
      title: "Create a Meta app in the developer portal",
      detail: "Sign in with the account that manages the Business Portfolio, then create an app of type Business.",
      link: { href: "https://developers.facebook.com/apps", label: "Open Meta apps" },
    },
    {
      title: "Link the app to your Business Portfolio",
      detail: "In App settings → Basic, connect the app to the Business Portfolio that owns your Pages.",
      link: { href: "https://business.facebook.com/settings", label: "Open Business settings" },
    },
    {
      title: "Add Facebook Login and paste this redirect address",
      detail: "Products → Facebook Login → Settings. Paste the address below into Valid OAuth Redirect URIs exactly as shown.",
      showRedirectUri: true,
    },
    {
      title: "Request the Page permissions",
      detail:
        "Add pages_show_list, pages_read_engagement, pages_read_user_content and business_management. Live access to other people's Pages needs Meta App Review; your own Pages work in development mode.",
      link: { href: "https://developers.facebook.com/docs/graph-api/reference/page/ratings/", label: "Open Meta docs" },
    },
  ],
  trustpilot: [
    {
      title: "Sign in to the Trustpilot Business account",
      detail: "You need a paid Trustpilot plan that includes API access for your verified business unit.",
      link: { href: "https://businessapp.b2b.trustpilot.com/", label: "Open Trustpilot Business" },
    },
    {
      title: "Create an API application",
      detail: "Integrations → API → create an application and copy the API key (also shown as the application key).",
      link: { href: "https://documentation-apidocumentation.trustpilot.com/", label: "Open Trustpilot API docs" },
    },
  ],
  semrush: [
    {
      title: "Open your Semrush profile",
      detail: "API units are sold separately — a Business or Guru plan with API units is required.",
      link: { href: "https://www.semrush.com/accounts/subscription-info/api-units/", label: "Open Semrush API units" },
    },
    {
      title: "Copy the API key",
      detail: "Profile → Subscription info → API units shows your personal API key.",
      link: { href: "https://developer.semrush.com/api/", label: "Open Semrush API docs" },
    },
  ],
};

/** Steps derived from the provider registry when no hand-written guide exists. */
function genericSteps(definition: IntegrationDefinition): ConsoleStep[] {
  const steps: ConsoleStep[] = [
    {
      title: `Open the ${definition.label} developer documentation`,
      detail:
        definition.kind === "oauth2"
          ? "Create an application for your business account, then copy its client ID and secret."
          : "Sign in to your provider account and create an API key for this business.",
      link: { href: definition.docsUrl, label: "Open provider docs" },
    },
  ];
  if (definition.approvalRequired) {
    steps.push({ title: "Provider approval required", detail: definition.approvalRequired });
  }
  if (definition.kind === "oauth2") {
    steps.push({
      title: "Add this redirect address to the application",
      detail: "Paste the address below into the provider's allowed OAuth redirect URIs exactly as shown.",
      showRedirectUri: true,
    });
  }
  return steps;
}

function StepRow({ index, done, children }: { index: number; done: boolean; children: ReactNode }) {
  return (
    <li className={`rounded-lg border p-3 transition-colors ${done ? "border-positive/30 bg-positive/5" : "bg-background"}`}>
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
            done ? "bg-positive text-white" : "bg-muted text-muted-foreground"
          }`}
        >
          {done ? <Check className="size-3" /> : index}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </li>
  );
}

/**
 * Guided setup for credential-based providers: console steps, inline credential entry,
 * then a real provider request that reports the live status.
 */
export function ProviderSetupGuide({
  definition,
  credentialsReady,
  verified,
  accountRef,
  onChanged,
}: {
  definition: IntegrationDefinition;
  credentialsReady: boolean;
  verified: boolean;
  accountRef?: string | null;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [account, setAccount] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const saveCredsFn = useServerFn(saveProviderCredentials);
  const saveAccountFn = useServerFn(saveIntegrationAccount);
  const testFn = useServerFn(testIntegration);
  const startFn = useServerFn(startIntegrationOAuth);

  const consoleSteps = CONSOLE_STEPS[definition.id] ?? genericSteps(definition);
  const redirectUri =
    typeof window === "undefined" ? "" : `${window.location.origin}/api/public/integrations/callback`;
  const savedAccount = (accountRef ?? "").trim();

  const applyTest = (test: { ok: boolean; message: string }) => {
    setResult(test);
    if (test.ok) toast.success(test.message);
    else toast.error(test.message);
    onChanged?.();
  };

  const saveAndTest = useMutation({
    mutationFn: async () => {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
      if (Object.keys(filled).length > 0) {
        await saveCredsFn({ data: { provider: definition.id, values: filled } });
      }
      if (definition.accountField && account.trim()) {
        await saveAccountFn({ data: { provider: definition.id, accountRef: account.trim() } });
      }
      return testFn({ data: { provider: definition.id } });
    },
    onSuccess: (test) => {
      setValues({});
      applyTest(test);
    },
    onError: (error: Error) => {
      setResult({ ok: false, message: error.message });
      toast.error(error.message);
    },
  });

  const retest = useMutation({
    mutationFn: () => testFn({ data: { provider: definition.id } }),
    onSuccess: applyTest,
    onError: (error: Error) => toast.error(error.message),
  });

  const connect = useMutation({
    mutationFn: () => startFn({ data: { provider: definition.id, origin: window.location.origin } }),
    onSuccess: (r) => {
      const popup = window.open(r.authorizationUrl, "_blank", "noopener,noreferrer");
      if (!popup) window.location.assign(r.authorizationUrl);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const busy = saveAndTest.isPending || retest.isPending;
  const needsAccount = Boolean(definition.accountField) && !savedAccount && !account.trim();
  const hasInput = Object.values(values).some((v) => v.trim()) || Boolean(account.trim());

  const totalSteps = consoleSteps.length + 1 + (definition.kind === "oauth2" ? 1 : 0);
  const doneSteps = (credentialsReady ? consoleSteps.length : 0) + (verified ? 1 : 0) + (definition.kind === "oauth2" && verified ? 1 : 0);

  return (
    <div className="mt-3 rounded-lg border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        <Sparkles className="size-3.5 text-primary" />
        Guided setup
        <span className="font-normal">
          · step {Math.min(doneSteps + 1, totalSteps)} of {totalSteps}
          {doneSteps === totalSteps ? " · complete" : ""}
        </span>
        <ChevronDown className={`ml-auto size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t p-3">
          <ol className="space-y-2.5">
            {consoleSteps.map((step, i) => (
              <StepRow key={step.title} index={i + 1} done={credentialsReady}>
                <p className="text-xs font-semibold">{step.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{step.detail}</p>
                {step.showRedirectUri && (
                  <div className="mt-1.5 flex items-center gap-2 rounded-md border border-dashed px-2 py-1">
                    <code className="min-w-0 flex-1 truncate text-[11px]">{redirectUri}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void navigator.clipboard.writeText(redirectUri);
                        toast.success("Copied");
                      }}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                )}
                {step.link && (
                  <a
                    href={step.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                  >
                    <ExternalLink className="size-3" /> {step.link.label}
                  </a>
                )}
              </StepRow>
            ))}

            <StepRow index={consoleSteps.length + 1} done={verified}>
              <p className="text-xs font-semibold">Paste the details here and verify</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {verified
                  ? "Saved and confirmed working against the live API."
                  : credentialsReady
                    ? "Details are saved but not confirmed yet. Press Test again, or paste new values to replace them."
                    : "Values are encrypted on the server and checked immediately with a real provider request."}
              </p>
              <div className="mt-2 space-y-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  {(definition.credentialFields ?? []).map((field) => (
                    <label key={field.key} className="block">
                      <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">{field.label}</span>
                      <input
                        type={field.secret ? "password" : "text"}
                        autoComplete="off"
                        spellCheck={false}
                        value={values[field.key] ?? ""}
                        placeholder={field.placeholder ?? (credentialsReady ? "Enter a new value to replace" : "")}
                        onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                        className="h-9 w-full rounded-lg border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring/40"
                      />
                    </label>
                  ))}
                  {definition.accountField && (
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                        {definition.accountField.label}
                      </span>
                      <input
                        value={account || savedAccount}
                        onChange={(e) => setAccount(e.target.value)}
                        className="h-9 w-full rounded-lg border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring/40"
                      />
                      <span className="mt-1 block text-[11px] text-muted-foreground">{definition.accountField.hint}</span>
                    </label>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={busy || !hasInput || needsAccount} onClick={() => saveAndTest.mutate()}>
                    {saveAndTest.isPending && <Loader2 className="animate-spin" />} Save &amp; verify
                  </Button>
                  {credentialsReady && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => retest.mutate()}>
                      {retest.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Test again
                    </Button>
                  )}
                </div>
                {result && <p className={`text-[11px] ${result.ok ? "text-positive" : "text-negative"}`}>{result.message}</p>}
                <p className="text-[11px] text-muted-foreground">
                  Saved secrets never come back to this page — only the live result is shown.
                </p>
              </div>
            </StepRow>

            {definition.kind === "oauth2" && (
              <StepRow index={consoleSteps.length + 2} done={verified}>
                <p className="text-xs font-semibold">Connect the account</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  A provider window opens — sign in with the account that manages the business and press Allow.
                </p>
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={!credentialsReady || connect.isPending}
                  onClick={() => connect.mutate()}
                >
                  {connect.isPending && <Loader2 className="animate-spin" />} Connect {definition.label}
                </Button>
              </StepRow>
            )}
          </ol>
        </div>
      )}
    </div>
  );
}
