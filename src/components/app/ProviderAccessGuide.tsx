import { ExternalLink } from "lucide-react";
import { googleBlockerAction } from "@/lib/integrations/provider-blockers";

const GUIDES: Record<string, { next: string; steps: string[]; links: [string, string][] }> = {
  indeed: {
    next: "Contact Indeed partnerships and confirm that your agreement includes company-review data. No self-service review key is available here.",
    steps: ["Choose the relevant partnership track; this is a partner enquiry, not instant API approval.", "After acceptance, Indeed provisions an app in Partner Console. Ask your representative which services and review-data rights are included.", "Provide the approved integration contract before enabling an adapter. A partner key alone does not establish review access."],
    links: [["Indeed partnerships", "https://www.indeed.com/partners"], ["Official integration steps", "https://docs.indeed.com/getstarted/integrate-and-call-apis"], ["Partner Console documentation", "https://docs.indeed.com/getstarted/partner-console"]],
  },
  glassdoor: {
    next: "Contact Glassdoor about API partnership and permitted employer-review access; no current public self-service approval form is verified.",
    steps: ["Request written confirmation of available endpoints, review-data rights and partner credentials.", "Confirm attribution, storage and display terms with Glassdoor before using any returned data.", "This integration stays blocked until an approved contract and supported adapter are available; a profile URL is not API access."],
    links: [["Official Glassdoor API information", "https://www.glassdoor.com/developer/index.htm"]],
  },
  meta_business: {
    next: "Configure your Meta app and request the required business_management access in App Review; this separate Business Suite adapter is not enabled.",
    steps: ["Use the app connected to your Business Portfolio and configure the relevant login/use case.", "In App Review / Permissions and Features, request the access required for business_management and the actual assets. Follow the dashboard's current requirements for business verification, demonstrations and reviewer access.", "Development access for app-role accounts is not approval for external clients. Marketing API access tiers are separate from Graph permission access.", "After approval, connect Facebook/Instagram and run their real tests; this Business Suite entry remains a documented gate, not a live API test."],
    links: [["Meta app dashboard", "https://developers.facebook.com/apps"], ["Business asset documentation", "https://developers.facebook.com/docs/marketing-api/business-asset-management"], ["Marketing API access", "https://developers.facebook.com/docs/marketing-apis/get-started"]],
  },
};

export function ProviderAccessGuide({ provider, outcomeCode, lastError }: { provider: string; outcomeCode?: string | null; lastError?: string | null }) {
  const guide = GUIDES[provider];
  const google = provider === "pagespeed" || provider === "url_reputation";
  if (!guide && !google) return null;
  if (google && outcomeCode === "CONNECTED") return null;
  return (
    <div className="mt-3 border-l-2 border-border pl-3 text-xs">
      <p className="font-semibold">Next action</p>
      <p className="mt-1 text-muted-foreground">{guide?.next ?? googleBlockerAction(provider, lastError)}</p>
      {guide && <p className="mt-1 text-muted-foreground">Access gate only — no provider API call has been made for this entry.</p>}
      {provider === "url_reputation" && <p className="mt-1 text-warning">Google Safe Browsing is non-commercial only. Revenue-generating use requires Google Web Risk; enabling Safe Browsing does not grant commercial rights.</p>}
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">Official access and approval steps</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
          {(guide?.steps ?? ["Select the Google Cloud project that owns the saved key. In APIs & Services → Library, enable the required API.", "In APIs & Services → Credentials, select the key and allow the required API under API restrictions. Application restrictions must match server calls, not browser referrers.", "Check the API's project quotas, wait for settings to propagate, then use Test connection. Only a successful real response changes the status to Connected."]).map(step => <li key={step}>{step}</li>)}
        </ol>
        <div className="mt-2 flex flex-wrap gap-3">
          {(guide?.links ?? [["Google Cloud APIs", "https://console.cloud.google.com/apis/library"], ["API key restrictions", "https://docs.cloud.google.com/api-keys/docs/add-restrictions"], ["Official API setup", provider === "pagespeed" ? "https://developers.google.com/speed/docs/insights/v5/get-started" : "https://developers.google.com/safe-browsing/v4/get-started"], ...(provider === "url_reputation" ? [["Usage terms / Web Risk", "https://developers.google.com/safe-browsing/v4/usage-limits"]] : [])]).map(([label, href]) => <a key={href} href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="size-3" />{label}</a>)}
        </div>
      </details>
    </div>
  );
}