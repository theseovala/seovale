import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, ChevronDown, Copy, ExternalLink, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/seovale-db";
import {
  getGoogleBusinessConnection,
  startGoogleBusinessConnection,
  syncGoogleBusinessReviews,
} from "@/lib/google-business.functions";
import { saveProviderCredentials, testIntegration } from "@/lib/integrations.functions";

/** Opens Google authorization reliably, even inside a sandboxed preview frame. */
function openAuthorization(url: string, authWindow: Window | null) {
  const fallback = () => {
    const popup = window.open(url, "_blank", "noopener,noreferrer");
    if (!popup) window.location.assign(url);
  };
  if (!authWindow || authWindow.closed) {
    fallback();
    return;
  }
  try {
    authWindow.opener = null;
    authWindow.location.href = url;
  } catch {
    authWindow.close();
    fallback();
    return;
  }
  window.setTimeout(() => {
    let stuck = true;
    try {
      stuck = authWindow.closed ? false : authWindow.location.href === "about:blank";
    } catch {
      stuck = false;
    }
    if (stuck) {
      try {
        authWindow.close();
      } catch {
        /* ignore */
      }
      fallback();
    }
  }, 1500);
}

type Step = {
  title: string;
  detail: string;
  done: boolean;
  link?: { href: string; label: string };
  action?: ReactNode;
  copy?: string;
};

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-2.5">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className={`rounded-lg border p-3 transition-colors ${step.done ? "border-positive/30 bg-positive/5" : "bg-background"}`}
        >
          <div className="flex items-start gap-2.5">
            <span
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                step.done ? "bg-positive text-white" : "bg-muted text-muted-foreground"
              }`}
            >
              {step.done ? <Check className="size-3" /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{step.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{step.detail}</p>
              {step.copy && (
                <div className="mt-1.5 flex items-center gap-2 rounded-md border border-dashed px-2 py-1">
                  <code className="min-w-0 flex-1 truncate text-[11px]">{step.copy}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(step.copy as string);
                      toast.success("Copied");
                    }}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {step.link && (
                  <a
                    href={step.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                  >
                    <ExternalLink className="size-3" /> {step.link.label}
                  </a>
                )}
                {step.action}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function GuideShell({ done, total, children }: { done: number; total: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
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
          · step {Math.min(done + 1, total)} of {total}
          {done === total ? " · complete" : ""}
        </span>
        <ChevronDown className={`ml-auto size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t p-3">{children}</div>}
    </div>
  );
}

/** Google Business Profile: console setup → credentials → authorize → first sync. */
export function GoogleBusinessSetupGuide({ credentialsReady }: { credentialsReady: boolean }) {
  const queryClient = useQueryClient();
  const statusFn = useServerFn(getGoogleBusinessConnection);
  const startFn = useServerFn(startGoogleBusinessConnection);
  const syncFn = useServerFn(syncGoogleBusinessReviews);
  const connection = useQuery({ queryKey: ["google_business_connection"], queryFn: () => statusFn() });

  const connect = useMutation({
    mutationFn: ({ authWindow }: { authWindow: Window | null }) =>
      startFn({ data: { origin: window.location.origin } }).then((result) => ({ ...result, authWindow })),
    onSuccess: ({ authorizationUrl, authWindow }) => openAuthorization(authorizationUrl, authWindow),
    onError: (error: Error, { authWindow }) => {
      authWindow?.close();
      toast.error(error.message);
    },
  });

  const sync = useMutation({
    mutationFn: () => syncFn(),
    onSuccess: (result) => {
      toast.success(`Google synced: ${result.reviewsCreated} new, ${result.reviewsUpdated} updated`);
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const redirectUri =
    typeof window === "undefined" ? "" : `${window.location.origin}/api/public/google-business/callback`;
  const configured = credentialsReady || Boolean(connection.data?.configured);
  const connected = Boolean(connection.data?.connected);
  const synced = Boolean(connection.data?.lastSyncedAt);

  const steps: Step[] = [
    {
      title: "Create a Google Cloud project",
      detail: "Sign in with the Google account that owns or manages the business listing, then create a project (any name).",
      done: configured,
      link: { href: "https://console.cloud.google.com/projectcreate", label: "Open project creation" },
    },
    {
      title: "Turn on the Business Profile API",
      detail: "Press Enable on the My Business Account Management and Business Profile APIs. Google may ask for a short access request — approval usually takes a few days.",
      done: configured,
      link: { href: "https://developers.google.com/my-business/content/prereqs", label: "Open access request steps" },
    },
    {
      title: "Set up the consent screen",
      detail: "Choose External, fill in the app name and support email, and publish it. Without publishing, only test users can connect.",
      done: configured,
      link: { href: "https://console.cloud.google.com/apis/credentials/consent", label: "Open consent screen" },
    },
    {
      title: "Create a web OAuth client and paste this address",
      detail: "Credentials → Create credentials → OAuth client ID → Web application. Paste the address below into Authorized redirect URIs exactly as shown.",
      done: configured,
      copy: redirectUri,
      link: { href: "https://console.cloud.google.com/apis/credentials", label: "Open credentials" },
    },
    {
      title: "Save the Client ID and secret here",
      detail: configured
        ? "Saved and encrypted on the server."
        : "Copy both values from the OAuth client you just made and save them in the Provider credentials panel below.",
      done: configured,
    },
    {
      title: "Connect the Google account",
      detail: connected
        ? `Connected as ${connection.data?.email ?? "your Google account"}.`
        : "A Google window opens — sign in with the account that manages the business and press Allow.",
      done: connected,
      action: (
        <Button
          size="sm"
          disabled={!configured || connect.isPending}
          onClick={() => connect.mutate({ authWindow: window.open("", "_blank", "noopener,noreferrer") })}
        >
          {connect.isPending && <Loader2 className="animate-spin" />}
          {connected ? "Reconnect Google" : "Connect Google"}
        </Button>
      ),
    },
    {
      title: "Bring in your reviews",
      detail: synced
        ? `Last synced ${relativeTime(connection.data?.lastSyncedAt as string)}.`
        : "Pulls your real locations and reviews. After this, syncing continues automatically.",
      done: synced,
      action: (
        <Button size="sm" variant="outline" disabled={!connected || sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now
        </Button>
      ),
    },
  ];

  if (connection.data?.lastError) {
    steps.push({
      title: "Last problem reported by Google",
      detail: connection.data.lastError,
      done: false,
    });
  }

  return (
    <GuideShell done={steps.filter((s) => s.done).length} total={steps.length}>
      <StepList steps={steps} />
    </GuideShell>
  );
}

/** Google Maps Platform: project + billing → enable APIs → server key → save + real verify. */
export function GoogleMapsSetupGuide({
  credentialsReady,
  verified,
  onChanged,
}: {
  credentialsReady: boolean;
  verified: boolean;
  onChanged?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const saveFn = useServerFn(saveProviderCredentials);
  const testFn = useServerFn(testIntegration);

  const saveAndTest = useMutation({
    mutationFn: async (key: string) => {
      await saveFn({ data: { provider: "google_maps", values: { GOOGLE_MAPS_API_KEY: key } } });
      return testFn({ data: { provider: "google_maps" } });
    },
    onSuccess: (test) => {
      setApiKey("");
      setResult({ ok: test.ok, message: test.message });
      if (test.ok) toast.success(test.message);
      else toast.error(test.message);
      onChanged?.();
    },
    onError: (error: Error) => {
      setResult({ ok: false, message: error.message });
      toast.error(error.message);
    },
  });

  const retest = useMutation({
    mutationFn: () => testFn({ data: { provider: "google_maps" } }),
    onSuccess: (test) => {
      setResult({ ok: test.ok, message: test.message });
      if (test.ok) toast.success(test.message);
      else toast.error(test.message);
      onChanged?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const busy = saveAndTest.isPending || retest.isPending;

  const steps: Step[] = [
    {
      title: "Create a Google Cloud project with billing",
      detail: "Maps needs billing switched on even for free monthly usage. Add a card once in Billing.",
      done: credentialsReady,
      link: { href: "https://console.cloud.google.com/billing", label: "Open billing" },
    },
    {
      title: "Switch on Places API (New) and Geocoding API",
      detail: "Search each API by name in the library and press Enable.",
      done: credentialsReady,
      link: { href: "https://console.cloud.google.com/apis/library", label: "Open API library" },
    },
    {
      title: "Create an API key for server use",
      detail:
        "Credentials → Create credentials → API key. Under Application restrictions choose None or IP addresses (never website restrictions — this key is used by the server). Under API restrictions select only the two APIs above.",
      done: credentialsReady,
      link: { href: "https://console.cloud.google.com/apis/credentials", label: "Open credentials" },
    },
    {
      title: "Paste the key here and verify",
      detail: verified
        ? "Key saved and confirmed working against the live Google API."
        : credentialsReady
          ? "A key is saved but not confirmed yet. Press Test again, or paste a new key to replace it."
          : "Paste the key below. It is encrypted on the server and checked immediately with a real Google request.",
      done: verified,
      action: (
        <div className="w-full space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder={credentialsReady ? "Enter a new key to replace the saved one" : "AIza..."}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-9 min-w-[220px] flex-1 rounded-lg border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring/40"
            />
            <Button size="sm" disabled={busy || !apiKey.trim()} onClick={() => saveAndTest.mutate(apiKey.trim())}>
              {saveAndTest.isPending && <Loader2 className="animate-spin" />} Save &amp; verify
            </Button>
            {credentialsReady && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => retest.mutate()}>
                {retest.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Test again
              </Button>
            )}
          </div>
          {result && (
            <p className={`text-[11px] ${result.ok ? "text-positive" : "text-negative"}`}>{result.message}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            The key never comes back to this page — only the live test result is shown.
          </p>
        </div>
      ),
    },
  ];

  return (
    <GuideShell done={steps.filter((s) => s.done).length} total={steps.length}>
      <StepList steps={steps} />
    </GuideShell>
  );
}
