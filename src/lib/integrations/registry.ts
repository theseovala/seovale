// Client-safe metadata for every third-party account Seovale can connect.
// Only names and documentation links live here — never secret values.

export type IntegrationKind = "oauth2" | "api_key" | "managed" | "manual";

export interface CredentialField {
  /** Storage key — matches the server environment variable name. */
  key: string;
  label: string;
  /** Secret values are write-only: they are never returned to the browser. */
  secret: boolean;
  placeholder?: string;
  hint?: string;
}

export interface IntegrationDefinition {
  id: string;
  group: string;
  label: string;
  description: string;
  kind: IntegrationKind;
  /** Environment variable names (values never leave the server). */
  requiredSecrets: string[];
  scopes: string[];
  docsUrl: string;
  /** Extra identifier the admin must supply for api_key providers. */
  accountField?: { label: string; hint: string };
  /** Why a manual provider cannot be self-served. */
  manualReason?: string;
  /**
   * Vault bucket the credentials are stored under. Providers that share one
   * developer application (Gmail + YouTube, Facebook + Instagram) share a group.
   */
  credentialGroup?: string;
  /** Provider-specific credential schema shown in the configuration panel. */
  credentialFields?: CredentialField[];
  /** Provider requires a separate approval beyond an API key (honest status). */
  approvalRequired?: string;
}

const GOOGLE_OAUTH_FIELDS: CredentialField[] = [
  { key: "GOOGLE_OAUTH_CLIENT_ID", label: "Client ID", secret: false, placeholder: "1234567890-abc.apps.googleusercontent.com" },
  { key: "GOOGLE_OAUTH_CLIENT_SECRET", label: "Client secret", secret: true, placeholder: "GOCSPX-..." },
  { key: "GOOGLE_API_KEY", label: "API key (optional)", secret: true, hint: "Only required for Google API-key endpoints." },
];

const META_FIELDS: CredentialField[] = [
  { key: "FACEBOOK_APP_ID", label: "App ID", secret: false },
  { key: "FACEBOOK_APP_SECRET", label: "App secret", secret: true },
];

export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: "google_business",
    group: "Google",
    label: "Google Business Profile",
    description: "Locations, reviews and public replies.",
    kind: "managed",
    requiredSecrets: ["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET"],
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    docsUrl: "https://developers.google.com/my-business/content/review-data",
    credentialGroup: "google_business",
    credentialFields: [
      { key: "GOOGLE_BUSINESS_CLIENT_ID", label: "Client ID", secret: false, placeholder: "...apps.googleusercontent.com" },
      { key: "GOOGLE_BUSINESS_CLIENT_SECRET", label: "Client secret", secret: true, placeholder: "GOCSPX-..." },
    ],
  },
  {
    id: "google_maps",
    group: "Google",
    label: "Google Maps / Places",
    description: "Public place data, ratings and review snippets via Places API (New).",
    kind: "api_key",
    requiredSecrets: ["GOOGLE_MAPS_API_KEY"],
    scopes: [],
    docsUrl: "https://developers.google.com/maps/documentation/places/web-service/overview",
    credentialGroup: "google_maps",
    credentialFields: [
      { key: "GOOGLE_MAPS_API_KEY", label: "API key", secret: true, hint: "Enable Places API (New) + Geocoding API on the key. Server-side use only." },
    ],
  },
  {
    id: "google_search_console",
    group: "Google",
    label: "Google Search Console",
    description: "Search performance and indexing data for verified properties.",
    kind: "oauth2",
    requiredSecrets: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly", "openid", "email"],
    docsUrl: "https://developers.google.com/webmaster-tools/about",
    credentialGroup: "google_oauth",
    credentialFields: GOOGLE_OAUTH_FIELDS,
  },
  {
    id: "google_analytics",
    group: "Google",
    label: "Google Analytics 4",
    description: "Traffic and audience data from the GA4 property.",
    kind: "oauth2",
    requiredSecrets: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    scopes: ["https://www.googleapis.com/auth/analytics.readonly", "openid", "email"],
    docsUrl: "https://developers.google.com/analytics/devguides/config/admin/v1",
    credentialGroup: "google_oauth",
    credentialFields: GOOGLE_OAUTH_FIELDS,
  },
  {
    id: "google_ads",
    group: "Google",
    label: "Google Ads",
    description: "Campaign performance via the Google Ads API.",
    kind: "oauth2",
    requiredSecrets: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"],
    scopes: ["https://www.googleapis.com/auth/adwords", "openid", "email"],
    docsUrl: "https://developers.google.com/google-ads/api/docs/start",
    credentialGroup: "google_oauth",
    credentialFields: [
      ...GOOGLE_OAUTH_FIELDS,
      { key: "GOOGLE_ADS_DEVELOPER_TOKEN", label: "Developer token", secret: true, hint: "Requires Google Ads API access approval." },
    ],
    approvalRequired: "Google Ads API developer tokens require an approved developer account (basic access).",
  },
  {
    id: "google_gmail",
    group: "Google",
    label: "Gmail",
    description: "Read review notification mail from the business inbox.",
    kind: "oauth2",
    requiredSecrets: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"],
    docsUrl: "https://developers.google.com/gmail/api/auth/scopes",
    credentialGroup: "google_oauth",
    credentialFields: GOOGLE_OAUTH_FIELDS,
  },
  {
    id: "youtube",
    group: "Google",
    label: "YouTube channel",
    description: "Channel comments and public video feedback.",
    kind: "oauth2",
    requiredSecrets: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    scopes: ["https://www.googleapis.com/auth/youtube.force-ssl", "openid", "email"],
    docsUrl: "https://developers.google.com/youtube/v3/guides/authentication",
    credentialGroup: "google_oauth",
    credentialFields: GOOGLE_OAUTH_FIELDS,
  },
  {
    id: "youtube_analytics",
    group: "Google",
    label: "YouTube Analytics",
    description: "Channel views, watch time and engagement reports.",
    kind: "oauth2",
    requiredSecrets: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    scopes: ["https://www.googleapis.com/auth/yt-analytics.readonly", "openid", "email"],
    docsUrl: "https://developers.google.com/youtube/analytics/reference/reports/query",
    credentialGroup: "google_oauth",
    credentialFields: GOOGLE_OAUTH_FIELDS,
  },
  {
    id: "facebook",
    group: "Meta",
    label: "Facebook Page",
    description: "Page ratings, recommendations and comments.",
    kind: "oauth2",
    requiredSecrets: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    scopes: ["pages_show_list", "pages_read_engagement", "pages_read_user_content", "business_management"],
    docsUrl: "https://developers.facebook.com/docs/graph-api/reference/page/ratings/",
    credentialGroup: "meta",
    credentialFields: META_FIELDS,
  },
  {
    id: "instagram",
    group: "Meta",
    label: "Instagram professional account",
    description: "Comments and mentions on the linked business account.",
    kind: "oauth2",
    requiredSecrets: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    scopes: ["instagram_basic", "instagram_manage_comments", "pages_show_list", "business_management"],
    docsUrl: "https://developers.facebook.com/docs/instagram-api/",
    credentialGroup: "meta",
    credentialFields: META_FIELDS,
  },
  {
    id: "whatsapp",
    group: "Meta",
    label: "WhatsApp Business",
    description: "WhatsApp Business Cloud API messaging and templates.",
    kind: "api_key",
    requiredSecrets: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
    scopes: [],
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    credentialGroup: "whatsapp",
    credentialFields: [
      { key: "WHATSAPP_ACCESS_TOKEN", label: "Access token", secret: true, hint: "System-user token with whatsapp_business_messaging." },
      { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number ID", secret: false, hint: "From the WhatsApp Business account in Meta Business." },
    ],
  },
  {
    id: "trustpilot",
    group: "Review sites",
    label: "Trustpilot business profile",
    description: "Service reviews for the verified business unit.",
    kind: "api_key",
    requiredSecrets: ["TRUSTPILOT_API_KEY"],
    scopes: [],
    docsUrl: "https://documentation-apidocumentation.trustpilot.com/",
    accountField: { label: "Business domain", hint: "e.g. seovale.com — used to resolve your Trustpilot business unit." },
    credentialGroup: "trustpilot",
    credentialFields: [{ key: "TRUSTPILOT_API_KEY", label: "API key", secret: true }],
  },
  {
    id: "tripadvisor",
    group: "Review sites",
    label: "Tripadvisor business listing",
    description: "Listing details and review summary via the Content API.",
    kind: "api_key",
    requiredSecrets: ["TRIPADVISOR_API_KEY"],
    scopes: [],
    docsUrl: "https://tripadvisor-content-api.readme.io/reference/overview",
    accountField: { label: "Listing name or location ID", hint: "Exact business name or numeric Tripadvisor location ID." },
    credentialGroup: "tripadvisor",
    credentialFields: [{ key: "TRIPADVISOR_API_KEY", label: "Content API key", secret: true }],
  },
  {
    id: "yelp",
    group: "Review sites",
    label: "Yelp Fusion",
    description: "Business details and reviews via the Yelp Fusion API.",
    kind: "api_key",
    requiredSecrets: ["YELP_FUSION_API_KEY"],
    scopes: [],
    docsUrl: "https://docs.developer.yelp.com/docs/fusion-intro",
    accountField: { label: "Business alias or ID", hint: "Yelp business alias, e.g. the slug from the business page URL." },
    credentialGroup: "yelp",
    credentialFields: [{ key: "YELP_FUSION_API_KEY", label: "API key", secret: true, hint: "Create at the Yelp Fusion dashboard." }],
  },
  {
    id: "reddit",
    group: "Community",
    label: "Reddit",
    description: "Brand mentions and threads via the Reddit API.",
    kind: "oauth2",
    requiredSecrets: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    scopes: ["identity", "read", "submit"],
    docsUrl: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
    credentialGroup: "reddit",
    credentialFields: [
      { key: "REDDIT_CLIENT_ID", label: "Client ID", secret: false },
      { key: "REDDIT_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "twitter",
    group: "Community",
    label: "X (Twitter)",
    description: "Mentions and replies through the X API v2.",
    kind: "oauth2",
    requiredSecrets: ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"],
    scopes: ["tweet.read", "users.read", "offline.access"],
    docsUrl: "https://developer.x.com/en/docs/authentication/oauth-2-0",
    credentialGroup: "twitter",
    credentialFields: [
      { key: "TWITTER_CLIENT_ID", label: "OAuth 2.0 Client ID", secret: false },
      { key: "TWITTER_CLIENT_SECRET", label: "OAuth 2.0 Client secret", secret: true },
    ],
  },
  {
    id: "pinterest",
    group: "Community",
    label: "Pinterest",
    description: "Boards, pins and engagement via the Pinterest API v5.",
    kind: "oauth2",
    requiredSecrets: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"],
    scopes: ["boards:read", "pins:read", "user_accounts:read"],
    docsUrl: "https://developers.pinterest.com/docs/getting-started/authentication/",
    credentialGroup: "pinterest",
    credentialFields: [
      { key: "PINTEREST_CLIENT_ID", label: "App ID (Client ID)", secret: false, hint: "From the Pinterest developer app." },
      { key: "PINTEREST_CLIENT_SECRET", label: "App secret", secret: true },
    ],
  },
  {
    id: "semrush",
    group: "SEO",
    label: "Semrush",
    description: "Keyword, ranking and traffic data via the Semrush Units API.",
    kind: "api_key",
    requiredSecrets: ["SEMRUSH_API_KEY"],
    scopes: [],
    docsUrl: "https://developer.semrush.com/api/",
    credentialGroup: "semrush",
    credentialFields: [{ key: "SEMRUSH_API_KEY", label: "API key", secret: true }],
  },
  {
    id: "ahrefs",
    group: "SEO",
    label: "Ahrefs",
    description: "Backlinks, keywords and site data via Ahrefs API v3.",
    kind: "api_key",
    requiredSecrets: ["AHREFS_API_TOKEN"],
    scopes: [],
    docsUrl: "https://docs.ahrefs.com/reference/get-available-datasets",
    credentialGroup: "ahrefs",
    credentialFields: [{ key: "AHREFS_API_TOKEN", label: "API token", secret: true, hint: "API access requires an Ahrefs plan with the API add-on." }],
    approvalRequired: "Ahrefs API access requires a plan with the API add-on enabled.",
  },
  {
    id: "moz",
    group: "SEO",
    label: "Moz",
    description: "Domain and page metrics via the Moz Links API v2.",
    kind: "api_key",
    requiredSecrets: ["MOZ_ACCESS_ID", "MOZ_SECRET_KEY"],
    scopes: [],
    docsUrl: "https://docs.moz.com/guides/moz-api/moz-api-reference/get-url-metrics",
    credentialGroup: "moz",
    credentialFields: [
      { key: "MOZ_ACCESS_ID", label: "Access ID", secret: false },
      { key: "MOZ_SECRET_KEY", label: "Secret key", secret: true },
    ],
  },
  {
    id: "dataforseo",
    group: "SEO",
    label: "DataForSEO",
    description: "SERP, keyword and backlink APIs (pay-as-you-go).",
    kind: "api_key",
    requiredSecrets: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    scopes: [],
    docsUrl: "https://docs.dataforseo.com/",
    credentialGroup: "dataforseo",
    credentialFields: [
      { key: "DATAFORSEO_LOGIN", label: "API login", secret: false },
      { key: "DATAFORSEO_PASSWORD", label: "API password", secret: true },
    ],
  },
  {
    id: "openai",
    group: "AI",
    label: "OpenAI",
    description: "Direct OpenAI API access for AI features (used as a provider fallback).",
    kind: "api_key",
    requiredSecrets: ["OPENAI_API_KEY"],
    scopes: [],
    docsUrl: "https://platform.openai.com/docs/api-reference",
    credentialGroup: "openai",
    credentialFields: [{ key: "OPENAI_API_KEY", label: "API key", secret: true, placeholder: "sk-..." }],
  },
  {
    id: "anthropic",
    group: "AI",
    label: "Anthropic (Claude)",
    description: "Direct Anthropic API access, used as the second AI fallback.",
    kind: "api_key",
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    scopes: [],
    docsUrl: "https://docs.anthropic.com/en/api",
    credentialGroup: "anthropic",
    credentialFields: [{ key: "ANTHROPIC_API_KEY", label: "API key", secret: true, placeholder: "sk-ant-..." }],
  },
  {
    id: "resend_email",
    group: "Communication",
    label: "Email (Resend)",
    description: "Transactional email delivery for alerts and digests.",
    kind: "api_key",
    requiredSecrets: ["RESEND_API_KEY"],
    scopes: [],
    docsUrl: "https://resend.com/docs/api-reference",
    credentialGroup: "resend_email",
    credentialFields: [{ key: "RESEND_API_KEY", label: "API key", secret: true }],
  },
  {
    id: "twilio_sms",
    group: "Communication",
    label: "SMS (Twilio)",
    description: "SMS delivery for critical negative-review alerts.",
    kind: "api_key",
    requiredSecrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    scopes: [],
    docsUrl: "https://www.twilio.com/docs/usage/api",
    accountField: { label: "Sender phone number", hint: "Twilio number or sender ID used as the SMS from-address." },
    credentialGroup: "twilio_sms",
    credentialFields: [
      { key: "TWILIO_ACCOUNT_SID", label: "Account SID", secret: false, placeholder: "AC..." },
      { key: "TWILIO_AUTH_TOKEN", label: "Auth token", secret: true },
    ],
  },
  {
    id: "stripe",
    group: "Payments",
    label: "Stripe",
    description: "Subscription billing and payment records.",
    kind: "api_key",
    requiredSecrets: ["STRIPE_SECRET_KEY"],
    scopes: [],
    docsUrl: "https://docs.stripe.com/api",
    credentialGroup: "stripe",
    credentialFields: [
      { key: "STRIPE_SECRET_KEY", label: "Secret key", secret: true, placeholder: "sk_live_... / sk_test_..." },
      { key: "STRIPE_WEBHOOK_SECRET", label: "Webhook signing secret", secret: true, placeholder: "whsec_..." },
    ],
  },
  {
    id: "razorpay",
    group: "Payments",
    label: "Razorpay",
    description: "Indian payment gateway for subscriptions and invoices.",
    kind: "api_key",
    requiredSecrets: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"],
    scopes: [],
    docsUrl: "https://razorpay.com/docs/api/",
    credentialGroup: "razorpay",
    credentialFields: [
      { key: "RAZORPAY_KEY_ID", label: "Key ID", secret: false, placeholder: "rzp_live_..." },
      { key: "RAZORPAY_KEY_SECRET", label: "Key secret", secret: true },
    ],
  },
  {
    id: "serpapi",
    group: "SEO",
    label: "SERP provider (SerpApi)",
    description: "Live search-results positions for tracked keywords.",
    kind: "api_key",
    requiredSecrets: ["SERPAPI_API_KEY"],
    scopes: [],
    docsUrl: "https://serpapi.com/search-api",
    credentialGroup: "serpapi",
    credentialFields: [{ key: "SERPAPI_API_KEY", label: "API key", secret: true }],
  },
  {
    id: "web_crawler",
    group: "Website intelligence",
    label: "Website crawler & screenshots (Firecrawl)",
    description: "Page crawling, content extraction and full-page rendering/screenshots.",
    kind: "api_key",
    requiredSecrets: ["FIRECRAWL_API_KEY"],
    scopes: [],
    docsUrl: "https://docs.firecrawl.dev/api-reference/v2-introduction",
    credentialGroup: "web_crawler",
    credentialFields: [{ key: "FIRECRAWL_API_KEY", label: "API key", secret: true, placeholder: "fc-..." }],
  },
  {
    id: "pagespeed",
    group: "Website intelligence",
    label: "PageSpeed / Lighthouse",
    description: "Core Web Vitals and Lighthouse scores from Google PageSpeed Insights.",
    kind: "api_key",
    requiredSecrets: ["PAGESPEED_API_KEY"],
    scopes: [],
    docsUrl: "https://developers.google.com/speed/docs/insights/v5/get-started",
    credentialGroup: "pagespeed",
    credentialFields: [
      { key: "PAGESPEED_API_KEY", label: "API key", secret: true, hint: "Google Cloud key with PageSpeed Insights API enabled." },
    ],
  },
  {
    id: "ssl_monitor",
    group: "Website intelligence",
    label: "SSL certificate monitoring",
    description: "Certificate grade and expiry checks via the public Qualys SSL Labs API.",
    kind: "api_key",
    requiredSecrets: [],
    scopes: [],
    accountField: { label: "Domain to monitor", hint: "e.g. seovale.com — scanned live by Qualys SSL Labs. No key required." },
    docsUrl: "https://github.com/ssllabs/ssllabs-scan/blob/master/ssllabs-api-docs-v3.md",
  },
  {
    id: "dns_rdap",
    group: "Website intelligence",
    label: "DNS / RDAP / WHOIS",
    description: "Domain registration, nameserver and expiry data from the public RDAP network.",
    kind: "api_key",
    requiredSecrets: [],
    scopes: [],
    accountField: { label: "Domain", hint: "e.g. seovale.com — looked up live over RDAP. No key required." },
    docsUrl: "https://about.rdap.org/",
  },
  {
    id: "uptime_monitor",
    group: "Website intelligence",
    label: "Uptime monitoring (UptimeRobot)",
    description: "Monitor availability and response time for tracked sites.",
    kind: "api_key",
    requiredSecrets: ["UPTIMEROBOT_API_KEY"],
    scopes: [],
    docsUrl: "https://uptimerobot.com/api/",
    credentialGroup: "uptime_monitor",
    credentialFields: [{ key: "UPTIMEROBOT_API_KEY", label: "API key", secret: true, placeholder: "u1234567-..." }],
  },
  {
    id: "url_reputation",
    group: "Website intelligence",
    label: "URL / security reputation",
    description: "Malware and phishing checks via Google Safe Browsing.",
    kind: "api_key",
    requiredSecrets: ["SAFE_BROWSING_API_KEY"],
    scopes: [],
    docsUrl: "https://developers.google.com/safe-browsing/v4/lookup-api",
    credentialGroup: "url_reputation",
    credentialFields: [
      { key: "SAFE_BROWSING_API_KEY", label: "API key", secret: true, hint: "Google Cloud key with Safe Browsing API enabled." },
    ],
  },
  {
    id: "indeed",
    group: "Employer",
    label: "Indeed employer profile",
    description: "Company reviews on Indeed.",
    kind: "manual",
    requiredSecrets: [],
    scopes: [],
    docsUrl: "https://docs.indeed.com/",
    manualReason:
      "Indeed does not publish a self-serve company-review API. Access requires an approved Indeed partner agreement, so this stays unconnected until credentials are granted.",
    approvalRequired: "Indeed company-review API access requires an approved Indeed partner agreement.",
  },
  {
    id: "meta_business",
    group: "Meta",
    label: "Meta Business Suite",
    description: "Business-level asset and page management for the connected Meta app.",
    kind: "manual",
    requiredSecrets: [],
    scopes: ["business_management"],
    docsUrl: "https://developers.facebook.com/docs/marketing-api/business-asset-management",
    manualReason:
      "Meta Business Suite data is read through the Facebook and Instagram connections above. A separate Business Suite connection needs the business_management permission, which Meta grants only after App Review.",
    approvalRequired: "business_management requires Meta App Review approval.",
  },
  {
    id: "lovable_ai",
    group: "AI",
    label: "Cloud AI gateway",
    description: "Built-in AI models used for scan analysis, reports and reply drafting.",
    kind: "api_key",
    requiredSecrets: ["LOVABLE_API_KEY"],
    scopes: [],
    docsUrl: "https://docs.lovable.dev/features/ai",
    credentialGroup: "lovable_ai",
  },
  {
    id: "glassdoor",
    group: "Employer",
    label: "Glassdoor employer profile",
    description: "Employer reviews and ratings.",
    kind: "manual",
    requiredSecrets: [],
    scopes: [],
    docsUrl: "https://www.glassdoor.com/developer/index.htm",
    manualReason:
      "Glassdoor closed its public review API; data access is partner-only. No connection can be established without an approved partner key.",
    approvalRequired: "Glassdoor API access is partner-only; requires an approved Glassdoor partnership.",
  },
];

export const integrationById = (id: string) => INTEGRATIONS.find((i) => i.id === id);

export const credentialGroupOf = (id: string) => integrationById(id)?.credentialGroup ?? id;

export type IntegrationStatus = "connected" | "disconnected" | "error" | "expired" | "unavailable";

/** Standardized live-test outcome codes (never converted into fake success). */
export type TestOutcomeCode =
  | "CONNECTED"
  | "NOT_CONFIGURED"
  | "INVALID_CREDENTIALS"
  | "AUTHENTICATION_FAILED"
  | "INSUFFICIENT_SCOPE"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "APPROVAL_REQUIRED"
  | "TOKEN_EXPIRED"
  | "UNAVAILABLE";

/**
 * Capability matrix — only capabilities the provider genuinely exposes to this
 * workspace are listed. An empty list means the provider has no usable public
 * capability here (partner-only or approval-gated).
 */
export const PROVIDER_CAPABILITIES: Record<string, string[]> = {
  google_business: ["Locations", "Reviews", "Owner replies"],
  google_maps: ["Place search", "Place details", "Ratings", "Review snippets"],
  google_search_console: ["Search performance", "Indexing status"],
  google_analytics: ["Traffic", "Audience", "Conversions"],
  google_ads: ["Campaign performance"],
  google_gmail: ["Send email"],
  youtube: ["Channel data", "Videos", "Comments"],
  youtube_analytics: ["Channel analytics"],
  facebook: ["Page data", "Page reviews", "Posts"],
  instagram: ["Profile data", "Media", "Comments"],
  whatsapp: ["Message sending", "Templates"],
  meta_business: [],
  trustpilot: ["Business profile", "Reviews"],
  tripadvisor: ["Location search", "Location details", "Review snippets"],
  yelp: ["Business search", "Business details", "Review snippets"],
  reddit: ["Brand mentions", "Comments"],
  twitter: ["Brand mentions", "Profile data"],
  pinterest: ["Profile data", "Pins"],
  semrush: ["Domain overview", "Keywords", "Backlinks"],
  ahrefs: ["Domain rating", "Backlinks"],
  moz: ["Domain authority", "Link metrics"],
  dataforseo: ["SERP data", "Keyword data"],
  serpapi: ["Live SERP positions"],
  anthropic: ["Text analysis", "Report writing"],
  openai: ["Text analysis", "Report writing"],
  lovable_ai: ["Text analysis", "Report writing", "Reply drafting"],
  resend_email: ["Transactional email"],
  twilio_sms: ["SMS alerts"],
  stripe: ["Account status"],
  razorpay: ["Account status"],
  web_crawler: ["Page crawling", "Content extraction", "Screenshots"],
  pagespeed: ["Core Web Vitals", "Lighthouse scores"],
  ssl_monitor: ["Certificate grade", "Expiry"],
  dns_rdap: ["DNS records", "Registration", "Expiry"],
  uptime_monitor: ["Availability", "Response time"],
  url_reputation: ["Malware check", "Phishing check"],
  indeed: [],
  glassdoor: [],
};

/** Documented provider limits used for throttling and backoff. */
export const PROVIDER_RATE_LIMITS: Record<string, string> = {
  google_business: "Google quota per project (default 300 requests/min)",
  google_maps: "Places API quota per key",
  google_search_console: "1,200 queries/min per property",
  google_analytics: "GA4 Data API tokens per property/day",
  youtube: "10,000 quota units/day",
  facebook: "Meta app-level rate limits (BUC)",
  instagram: "200 calls/hour per user",
  whatsapp: "Tier-based messaging limits",
  trustpilot: "Plan-based API limits",
  tripadvisor: "Key-based daily call cap",
  yelp: "500 calls/day on the free tier",
  reddit: "100 queries/min per client",
  twitter: "Tier-based 15-minute windows",
  semrush: "Unit-based API budget",
  ahrefs: "Row-based API budget",
  moz: "Plan-based monthly rows",
  dataforseo: "2,000 calls/min",
  serpapi: "Plan-based searches/month",
  openai: "Account tier RPM/TPM",
  anthropic: "Account tier RPM/TPM",
  lovable_ai: "Workspace AI gateway rate limit",
  pagespeed: "25,000 requests/day per key",
  url_reputation: "10,000 requests/day per key",
  uptime_monitor: "10 requests/min",
  ssl_monitor: "Qualys public assessment throttle",
  dns_rdap: "Public RDAP fair-use throttle",
  web_crawler: "Plan-based Firecrawl credits",
};

export const capabilitiesFor = (id: string) => PROVIDER_CAPABILITIES[id] ?? [];
export const rateLimitFor = (id: string) => PROVIDER_RATE_LIMITS[id] ?? null;

/** Human label for the authentication method shown in the integration centre. */
export const authTypeLabel: Record<IntegrationKind, string> = {
  oauth2: "OAuth 2.0",
  api_key: "API key",
  managed: "Managed",
  manual: "Partner access",
};
