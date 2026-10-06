// Real data collectors for the scan engine. Every function performs a genuine
// network request against a documented public endpoint. Nothing is simulated:
// when a source cannot be reached or is not configured, that is reported
// honestly and the raw provider payload is stored untouched.

export type SourceStatus = "completed" | "failed" | "skipped" | "not_configured";

export interface SourceResult {
  source: string;
  provider: string | null;
  status: SourceStatus;
  httpStatus?: number | null;
  durationMs: number;
  errorMessage?: string | null;
  raw: Record<string, unknown>;
}

const UA = "SeovaleScanner/1.0 (+https://seovale.com)";
const TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 800_000;

async function timed<T>(fn: () => Promise<T>) {
  const started = Date.now();
  try {
    const value = await fn();
    return { value, durationMs: Date.now() - started, error: null as Error | null };
  } catch (caught) {
    return { value: null as T | null, durationMs: Date.now() - started, error: caught instanceof Error ? caught : new Error(String(caught)) };
  }
}

const TRUSTED_HOSTS = new Set([
  "cloudflare-dns.com",
  "rdap.org",
  "www.googleapis.com",
  "safebrowsing.googleapis.com",
  "search.google.com",
]);

/** True for loopback, link-local, private and carrier-grade NAT address space. */
function isPrivateAddress(address: string) {
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const v6 = address.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return false;
}

const resolutionCache = new Map<string, string[]>();

async function resolveHost(hostname: string): Promise<string[]> {
  const cached = resolutionCache.get(hostname);
  if (cached) return cached;
  const addresses: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      { headers: { accept: "application/dns-json", "user-agent": UA }, signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) continue;
    const payload = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
    for (const answer of payload.Answer ?? []) {
      if (answer.type === 1 || answer.type === 28) addresses.push(answer.data);
    }
  }
  resolutionCache.set(hostname, addresses);
  return addresses;
}

/**
 * SSRF guard. Rejects non-HTTP schemes, embedded credentials, odd ports,
 * internal hostnames, literal private IPs and hostnames that resolve into
 * private, loopback, link-local or cloud-metadata address space.
 */
export async function assertPublicTarget(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That address could not be read as a website address.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https addresses can be scanned.");
  if (url.username || url.password) throw new Error("Addresses containing a username or password cannot be scanned.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Only the standard web ports 80 and 443 can be scanned.");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (TRUSTED_HOSTS.has(host)) return url;
  // Also checked here, so a redirect that lands on a listing page is refused on
  // that hop rather than being crawled as if it were the business site.
  assertScannableHost(host);
  if (host === "localhost" || /(^|\.)(local|internal|localdomain|home|lan|localhost)$/.test(host)) {
    throw new Error("Internal network addresses cannot be scanned.");
  }
  if (isPrivateAddress(host.replace(/^\[|\]$/g, ""))) throw new Error("Private network addresses cannot be scanned.");

  const addresses = await resolveHost(host);
  if (addresses.length === 0) throw new Error("That domain name could not be resolved.");
  if (addresses.some(isPrivateAddress)) throw new Error("That domain points at a private network address and cannot be scanned.");
  return url;
}

async function request(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = url;
    // Manual redirect handling: every hop is re-validated against the SSRF guard.
    for (let hop = 0; hop < 6; hop += 1) {
      await assertPublicTarget(current);
      const response = await fetch(current, {
        ...init,
        redirect: "manual",
        headers: { "user-agent": UA, accept: "*/*", ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return response;
        current = new URL(location, current).toString();
        continue;
      }
      return response;
    }
    throw new Error("The address redirected too many times.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hosts that are a map listing, a review permalink or a link shortener for one —
 * never a business website. Crawling them produces a confident-looking report
 * about the platform's own redirect page ("21 words of visible text", "no H1",
 * "business name is not published"), which is a false report about the business
 * the person actually meant. They are refused with an explanation instead.
 */
const LISTING_HOSTS: { pattern: RegExp; label: string }[] = [
  { pattern: /^(share\.google|goo\.gl|maps\.app\.goo\.gl|g\.page|maps\.google\.[a-z.]+)$/i, label: "Google Maps or Google review" },
  { pattern: /^(www\.)?google\.[a-z.]+$/i, label: "Google" },
  { pattern: /^(www\.)?(facebook|fb)\.com$/i, label: "Facebook" },
  { pattern: /^(www\.)?instagram\.com$/i, label: "Instagram" },
  { pattern: /^(www\.)?(twitter|x)\.com$/i, label: "X" },
  { pattern: /^(www\.)?(yelp|tripadvisor|trustpilot|justdial|glassdoor|indeed)\.[a-z.]+$/i, label: "review site" },
  { pattern: /^(bit\.ly|tinyurl\.com|t\.co|lnkd\.in)$/i, label: "shortened" },
];

function assertScannableHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const hit = LISTING_HOSTS.find((entry) => entry.pattern.test(host));
  if (!hit) return;
  if (hit.label === "shortened") {
    throw new Error("Shortened links cannot be scanned. Enter the business website address itself, for example seovale.com");
  }
  throw new Error(
    `That is a ${hit.label} link, not a business website, so scanning it would describe ${host} instead of the business. ` +
      `Enter the business website address, or connect the platform under Settings → Integrations to analyse its listing and reviews.`,
  );
}

export function normalizeTarget(input: string) {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid website address, for example seovale.com");
  }
  if (!url.hostname.includes(".")) throw new Error("Enter a valid website address, for example seovale.com");
  assertScannableHost(url.hostname);
  url.hash = "";
  return { url: url.toString(), domain: url.hostname.replace(/^www\./i, ""), origin: url.origin };
}


/** Loads the page itself: status, redirects, timing, response headers and HTML. */
export async function collectPage(url: string): Promise<SourceResult> {
  const run = await timed(async () => {
    const response = await request(url);
    const buffer = await response.arrayBuffer();
    const bytes = buffer.byteLength;
    const html = new TextDecoder().decode(buffer.slice(0, MAX_HTML_BYTES));
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { finalUrl: response.url || url, httpStatus: response.status, bytes, headers, html };
  });
  if (run.error || !run.value) {
    return {
      source: "http",
      provider: null,
      status: "failed",
      durationMs: run.durationMs,
      errorMessage: run.error?.message ?? "The website did not respond.",
      raw: {},
    };
  }
  return {
    source: "http",
    provider: null,
    status: "completed",
    httpStatus: run.value.httpStatus,
    durationMs: run.durationMs,
    raw: run.value as unknown as Record<string, unknown>,
  };
}

/** HTTPS reachability + transport security signals taken from the real response. */
export async function collectTls(origin: string): Promise<SourceResult> {
  const httpsOrigin = origin.replace(/^http:/i, "https:");
  const run = await timed(async () => {
    const response = await request(httpsOrigin, { method: "GET" });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { httpsReachable: true, httpStatus: response.status, finalUrl: response.url, headers };
  });
  if (run.error || !run.value) {
    return {
      source: "tls",
      provider: null,
      status: "failed",
      durationMs: run.durationMs,
      errorMessage: run.error?.message ?? "HTTPS connection failed.",
      raw: { httpsReachable: false },
    };
  }
  return {
    source: "tls",
    provider: null,
    status: "completed",
    httpStatus: run.value.httpStatus,
    durationMs: run.durationMs,
    raw: run.value as unknown as Record<string, unknown>,
  };
}

/** DNS over HTTPS (Cloudflare, RFC 8484 JSON API). */
export async function collectDns(domain: string): Promise<SourceResult> {
  const types = ["A", "AAAA", "MX", "NS", "TXT", "CAA"] as const;
  const run = await timed(async () => {
    const records: Record<string, string[]> = {};
    for (const type of types) {
      const response = await request(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!response.ok) throw new Error(`Cloudflare DNS returned HTTP ${response.status}`);
      const body = (await response.json()) as { Answer?: { data: string }[] };
      records[type] = (body.Answer ?? []).map((answer) => answer.data);
    }
    return records;
  });
  if (run.error || !run.value) {
    return { source: "dns", provider: "cloudflare-doh", status: "failed", durationMs: run.durationMs, errorMessage: run.error?.message ?? null, raw: {} };
  }
  return { source: "dns", provider: "cloudflare-doh", status: "completed", durationMs: run.durationMs, raw: run.value };
}

/** Domain registration data from the public RDAP bootstrap service. */
export async function collectRdap(domain: string): Promise<SourceResult> {
  const run = await timed(async () => {
    const response = await request(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: "application/rdap+json" } });
    if (response.status === 404) return { found: false, httpStatus: 404 };
    if (!response.ok) throw new Error(`RDAP returned HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    return { found: true, httpStatus: response.status, body };
  });
  if (run.error || !run.value) {
    return { source: "rdap", provider: "rdap.org", status: "failed", durationMs: run.durationMs, errorMessage: run.error?.message ?? null, raw: {} };
  }
  return {
    source: "rdap",
    provider: "rdap.org",
    status: "completed",
    httpStatus: (run.value as any).httpStatus ?? null,
    durationMs: run.durationMs,
    raw: run.value as Record<string, unknown>,
  };
}

/** robots.txt and the sitemap it declares (or the conventional /sitemap.xml). */
export async function collectCrawlDirectives(origin: string): Promise<SourceResult> {
  const run = await timed(async () => {
    const robots = await request(`${origin}/robots.txt`);
    const robotsText = robots.ok ? (await robots.text()).slice(0, 20_000) : null;
    const declared = robotsText
      ? Array.from(robotsText.matchAll(/^\s*sitemap:\s*(\S+)/gim)).map((match) => match[1] as string)
      : [];
    const sitemapUrl = declared[0] ?? `${origin}/sitemap.xml`;
    let sitemap: { url: string; httpStatus: number; urlCount: number | null } | null = null;
    try {
      const response = await request(sitemapUrl);
      const text = response.ok ? (await response.text()).slice(0, 400_000) : "";
      sitemap = {
        url: sitemapUrl,
        httpStatus: response.status,
        urlCount: response.ok ? (text.match(/<loc>/g) ?? []).length : null,
      };
    } catch {
      sitemap = null;
    }
    return { robotsStatus: robots.status, robotsFound: robots.ok, robotsText, declaredSitemaps: declared, sitemap };
  });
  if (run.error || !run.value) {
    return { source: "crawl_directives", provider: null, status: "failed", durationMs: run.durationMs, errorMessage: run.error?.message ?? null, raw: {} };
  }
  return { source: "crawl_directives", provider: null, status: "completed", durationMs: run.durationMs, raw: run.value as Record<string, unknown> };
}

/** robots.txt Disallow rules that apply to our user-agent (or to *). */
export function disallowedPaths(robotsText: string | null) {
  if (!robotsText) return [] as string[];
  const rules: string[] = [];
  let applies = false;
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*" || value.toLowerCase().includes("seovale");
    else if (key === "disallow" && applies && value) rules.push(value);
  }
  return rules;
}

/**
 * Real multi-page crawl, bounded by page limit, same-domain rule, robots.txt
 * disallow rules and a per-request timeout. Never recursive without a limit.
 */
export async function collectCrawl(
  startUrl: string,
  robotsText: string | null,
  limit = 8,
): Promise<SourceResult> {
  const started = Date.now();
  try {
    const root = new URL(startUrl);
    const blocked = disallowedPaths(robotsText);
    const allowed = (url: URL) =>
      url.hostname.replace(/^www\./i, "") === root.hostname.replace(/^www\./i, "") &&
      !blocked.some((rule) => url.pathname.startsWith(rule));

    const queue: string[] = [root.toString()];
    const seen = new Set<string>([root.toString()]);
    const pages: {
      url: string;
      finalUrl: string;
      httpStatus: number;
      redirected: boolean;
      durationMs: number;
      title: string | null;
      description: string | null;
      canonical: string | null;
      h1Count: number;
      noindex: boolean;
      wordCount: number;
      internalLinks: number;
      externalLinks: number;
      images: number;
      imagesWithoutAlt: number;
      structuredData: number;
      hreflang: number;
    }[] = [];
    const outboundInternal = new Set<string>();

    while (queue.length && pages.length < limit) {
      const batch = queue.splice(0, 3);
      const results = await Promise.all(
        batch.map(async (pageUrl) => {
          const pageStarted = Date.now();
          try {
            const response = await request(pageUrl);
            const html = (await response.text()).slice(0, MAX_HTML_BYTES);
            return { pageUrl, response, html, durationMs: Date.now() - pageStarted };
          } catch {
            return null;
          }
        }),
      );
      for (const item of results) {
        if (!item) continue;
        const { pageUrl, response, html, durationMs } = item;
        const links = Array.from(html.matchAll(/href=["']([^"'#]+)["']/gi)).map((m) => m[1] as string);
        let internal = 0;
        let external = 0;
        for (const href of links) {
          let resolved: URL;
          try {
            resolved = new URL(href, pageUrl);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(resolved.protocol)) continue;
          resolved.hash = "";
          if (allowed(resolved)) {
            internal += 1;
            outboundInternal.add(resolved.toString());
            if (!seen.has(resolved.toString()) && seen.size < limit * 4) {
              seen.add(resolved.toString());
              queue.push(resolved.toString());
            }
          } else {
            external += 1;
          }
        }
        const imgs = Array.from(html.matchAll(/<img\b[^>]*>/gi)).map((m) => m[0] as string);
        pages.push({
          url: pageUrl,
          finalUrl: response.url || pageUrl,
          httpStatus: response.status,
          redirected: Boolean(response.url) && response.url !== pageUrl,
          durationMs,
          title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null,
          description: html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)?.[1]?.trim() ?? null,
          canonical: html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? null,
          h1Count: (html.match(/<h1[\s>]/gi) ?? []).length,
          noindex: /name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html),
          wordCount: html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").split(/\s+/).filter((w) => w.length > 1).length,
          internalLinks: internal,
          externalLinks: external,
          images: imgs.length,
          imagesWithoutAlt: imgs.filter((tag) => !/\balt\s*=/.test(tag)).length,
          structuredData: (html.match(/application\/ld\+json/gi) ?? []).length,
          hreflang: (html.match(/rel=["']alternate["'][^>]+hreflang=/gi) ?? []).length,
        });
      }
    }

    // Broken-link check on a bounded sample of discovered internal URLs.
    const sample = Array.from(outboundInternal)
      .filter((url) => !pages.some((page) => page.url === url))
      .slice(0, 15);
    const linkChecks = await Promise.all(
      sample.map(async (url) => {
        try {
          const response = await request(url, { method: "HEAD" });
          return { url, httpStatus: response.status };
        } catch (caught) {
          return { url, httpStatus: 0, error: caught instanceof Error ? caught.message : String(caught) };
        }
      }),
    );
    const broken = linkChecks.filter((check) => check.httpStatus === 0 || check.httpStatus >= 400);

    const titles = pages.map((page) => page.title ?? "").filter(Boolean);
    const duplicateTitles = titles.length - new Set(titles).size;

    return {
      source: "crawl",
      provider: null,
      status: pages.length ? "completed" : "failed",
      durationMs: Date.now() - started,
      errorMessage: pages.length ? null : "No page of this site could be crawled.",
      raw: {
        pagesCrawled: pages.length,
        limit,
        discoveredInternalUrls: outboundInternal.size,
        blockedByRobots: blocked,
        duplicateTitles,
        pages,
        linkChecks,
        brokenLinks: broken,
      },
    };
  } catch (caught) {
    return {
      source: "crawl",
      provider: null,
      status: "failed",
      durationMs: Date.now() - started,
      errorMessage: caught instanceof Error ? caught.message : String(caught),
      raw: {},
    };
  }
}

/** Business identity as published by the site itself (JSON-LD + visible contacts). */
export function extractIdentity(html: string) {
  const blocks = Array.from(html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1] as string);
  let name: string | null = null;
  let phone: string | null = null;
  let address: string | null = null;
  let website: string | null = null;
  let category: string | null = null;
  const sameAs: string[] = [];
  for (const block of blocks) {
    let parsed: any;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const nodes: any[] = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ? parsed["@graph"] : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = String(node["@type"] ?? "");
      if (!/Organization|LocalBusiness|Store|Restaurant|Hotel|Corporation|WebSite/i.test(type)) continue;
      name ??= typeof node.name === "string" ? node.name : null;
      phone ??= typeof node.telephone === "string" ? node.telephone : null;
      website ??= typeof node.url === "string" ? node.url : null;
      category ??= /LocalBusiness|Store|Restaurant|Hotel/i.test(type) ? type : category;
      if (node.address && typeof node.address === "object") {
        const parts = [node.address.streetAddress, node.address.addressLocality, node.address.postalCode, node.address.addressCountry]
          .filter((part: unknown) => typeof part === "string");
        if (parts.length) address ??= parts.join(", ");
      } else if (typeof node.address === "string") address ??= node.address;
      const links = Array.isArray(node.sameAs) ? node.sameAs : typeof node.sameAs === "string" ? [node.sameAs] : [];
      for (const link of links) if (typeof link === "string" && !sameAs.includes(link)) sameAs.push(link);
    }
  }
  if (!phone) {
    const tel = html.match(/href=["']tel:([^"']+)["']/i)?.[1];
    if (tel) phone = tel.trim();
  }
  return { name, phone, address, website, category, sameAs };
}


/**
 * Google PageSpeed Insights (Lighthouse). Requires a real Google API key from
 * the credential vault or the server environment; otherwise reported honestly
 * as not configured — never estimated.
 */
export async function collectPageSpeed(url: string, apiKey: string | null): Promise<SourceResult> {
  if (!apiKey) {
    return {
      source: "pagespeed",
      provider: "google_pagespeed",
      status: "not_configured",
      durationMs: 0,
      errorMessage: "Google PageSpeed API key is not configured.",
      raw: {},
    };
  }
  const endpoint =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}` +
    `&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices&key=${encodeURIComponent(apiKey)}`;
  const run = await timed(async () => {
    const response = await request(endpoint);
    const body = (await response.json()) as any;
    if (!response.ok) throw new Error(body?.error?.message ?? `PageSpeed returned HTTP ${response.status}`);
    const categories = body?.lighthouseResult?.categories ?? {};
    const audits = body?.lighthouseResult?.audits ?? {};
    return {
      httpStatus: response.status,
      categories: Object.fromEntries(Object.entries(categories).map(([key, value]: [string, any]) => [key, value?.score ?? null])),
      metrics: {
        firstContentfulPaint: audits["first-contentful-paint"]?.numericValue ?? null,
        largestContentfulPaint: audits["largest-contentful-paint"]?.numericValue ?? null,
        totalBlockingTime: audits["total-blocking-time"]?.numericValue ?? null,
        cumulativeLayoutShift: audits["cumulative-layout-shift"]?.numericValue ?? null,
        speedIndex: audits["speed-index"]?.numericValue ?? null,
      },
    };
  });
  if (run.error || !run.value) {
    return { source: "pagespeed", provider: "google_pagespeed", status: "failed", durationMs: run.durationMs, errorMessage: run.error?.message ?? null, raw: {} };
  }
  return {
    source: "pagespeed",
    provider: "google_pagespeed",
    status: "completed",
    httpStatus: (run.value as any).httpStatus ?? null,
    durationMs: run.durationMs,
    raw: run.value as Record<string, unknown>,
  };
}
