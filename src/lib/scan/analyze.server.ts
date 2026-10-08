// Normalization + analysis layer. Raw provider payloads (scan_sources) are
// turned into normalized measurements (scan_metrics) and findings
// (scan_findings). Anything a source did not return stays absent — it is never
// estimated, defaulted or invented.
import type { SourceResult } from "./collectors.server";
import {
  crawlPayload,
  directivesPayload,
  httpPayload,
  pageSpeedPayload,
  rdapPayload,
} from "./payloads";

export interface NormalizedMetric {
  category: string;
  metricKey: string;
  valueNumeric?: number | null;
  valueText?: string | null;
  unit?: string | null;
  source: string;
}

export interface Finding {
  category: string;
  code: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  recommendation?: string | null;
  impact: number;
  evidence?: Record<string, unknown>;
  source: string;
}

const text = (html: string, re: RegExp) => html.match(re)?.[1]?.trim() ?? null;

function parseHtml(html: string) {
  const title = text(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = text(
    html,
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i,
  );
  const canonical = text(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  const robotsMeta = text(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i);
  const viewport = text(html, /<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']+)["']/i);
  const lang = text(html, /<html[^>]+lang=["']([^"']+)["']/i);
  const ogTitle = text(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i);
  const h1 = Array.from(html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)).map((m) =>
    m[1]!.replace(/<[^>]+>/g, "").trim(),
  );
  const images = Array.from(html.matchAll(/<img\b[^>]*>/gi)).map((m) => m[0]!);
  const imagesWithoutAlt = images.filter((tag) => !/\balt\s*=/.test(tag)).length;
  const structuredData = (html.match(/application\/ld\+json/gi) ?? []).length;
  const wordCount = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1).length;
  return {
    title,
    description,
    canonical,
    robotsMeta,
    viewport,
    lang,
    ogTitle,
    h1,
    imageCount: images.length,
    imagesWithoutAlt,
    structuredData,
    wordCount,
  };
}

export function analyze(sources: SourceResult[]) {
  const metrics: NormalizedMetric[] = [];
  const findings: Finding[] = [];
  const by = (source: string) => sources.find((s) => s.source === source);

  // ---------- Availability / performance ----------
  const page = by("http");
  if (page?.status === "completed") {
    const raw = httpPayload.parse(page.raw);
    metrics.push({
      category: "availability",
      metricKey: "http_status",
      valueNumeric: raw.httpStatus,
      source: "http",
    });
    metrics.push({
      category: "performance",
      metricKey: "response_time",
      valueNumeric: page.durationMs,
      unit: "ms",
      source: "http",
    });
    metrics.push({
      category: "performance",
      metricKey: "page_bytes",
      valueNumeric: raw.bytes,
      unit: "bytes",
      source: "http",
    });
    metrics.push({
      category: "availability",
      metricKey: "final_url",
      valueText: raw.finalUrl,
      source: "http",
    });

    if (raw.httpStatus !== null && raw.httpStatus >= 400) {
      findings.push({
        category: "availability",
        code: "http_error",
        severity: "critical",
        title: `The page returns HTTP ${raw.httpStatus}`,
        detail: "Visitors and search engines cannot load this address successfully.",
        recommendation: "Fix the server response so the address returns HTTP 200.",
        impact: 30,
        evidence: { httpStatus: raw.httpStatus },
        source: "http",
      });
    }
    if (page.durationMs > 3000) {
      findings.push({
        category: "performance",
        code: "slow_response",
        severity: page.durationMs > 6000 ? "high" : "medium",
        title: `Slow server response (${(page.durationMs / 1000).toFixed(1)}s)`,
        detail:
          "The first response took longer than three seconds, which hurts both visitors and rankings.",
        recommendation: "Enable caching or a CDN and reduce server work on the first byte.",
        impact: page.durationMs > 6000 ? 12 : 7,
        evidence: { durationMs: page.durationMs },
        source: "http",
      });
    }

    // ---------- On-page SEO ----------
    const html = String(raw.html ?? "");
    if (html) {
      const parsed = parseHtml(html);
      metrics.push({
        category: "seo",
        metricKey: "title",
        valueText: parsed.title,
        source: "http",
      });
      metrics.push({
        category: "seo",
        metricKey: "title_length",
        valueNumeric: parsed.title?.length ?? 0,
        source: "http",
      });
      metrics.push({
        category: "seo",
        metricKey: "meta_description",
        valueText: parsed.description,
        source: "http",
      });
      metrics.push({
        category: "seo",
        metricKey: "h1_count",
        valueNumeric: parsed.h1.length,
        source: "http",
      });
      metrics.push({
        category: "seo",
        metricKey: "word_count",
        valueNumeric: parsed.wordCount,
        source: "http",
      });
      metrics.push({
        category: "seo",
        metricKey: "canonical",
        valueText: parsed.canonical,
        source: "http",
      });
      metrics.push({
        category: "seo",
        metricKey: "structured_data_blocks",
        valueNumeric: parsed.structuredData,
        source: "http",
      });
      metrics.push({
        category: "content",
        metricKey: "images",
        valueNumeric: parsed.imageCount,
        source: "http",
      });
      metrics.push({
        category: "content",
        metricKey: "images_without_alt",
        valueNumeric: parsed.imagesWithoutAlt,
        source: "http",
      });

      if (!parsed.title) {
        findings.push({
          category: "seo",
          code: "missing_title",
          severity: "high",
          title: "Page title is missing",
          detail: "Search engines have no title to show for this page.",
          recommendation: "Add a unique title of roughly 50–60 characters.",
          impact: 12,
          source: "http",
        });
      } else if (parsed.title.length > 65) {
        findings.push({
          category: "seo",
          code: "long_title",
          severity: "low",
          title: "Page title is long",
          detail: `The title is ${parsed.title.length} characters and will be cut off in search results.`,
          recommendation: "Shorten the title to about 60 characters.",
          impact: 3,
          evidence: { title: parsed.title },
          source: "http",
        });
      }
      if (!parsed.description) {
        findings.push({
          category: "seo",
          code: "missing_meta_description",
          severity: "medium",
          title: "Meta description is missing",
          detail: "Search engines will generate their own snippet for this page.",
          recommendation: "Add a 140–160 character description that summarises the page.",
          impact: 8,
          source: "http",
        });
      }
      if (parsed.h1.length === 0) {
        findings.push({
          category: "seo",
          code: "missing_h1",
          severity: "medium",
          title: "No main heading (H1)",
          detail: "The page has no primary heading, which weakens topical clarity.",
          recommendation: "Add one clear H1 describing the page.",
          impact: 6,
          source: "http",
        });
      } else if (parsed.h1.length > 1) {
        findings.push({
          category: "seo",
          code: "multiple_h1",
          severity: "low",
          title: `${parsed.h1.length} main headings found`,
          detail: "Multiple H1 headings dilute the page's main topic.",
          recommendation: "Keep a single H1 and use H2/H3 below it.",
          impact: 2,
          source: "http",
        });
      }
      if (!parsed.canonical) {
        findings.push({
          category: "seo",
          code: "missing_canonical",
          severity: "low",
          title: "No canonical address",
          detail:
            "Without a canonical link, duplicate versions of the page can compete with each other.",
          recommendation: "Add a canonical link tag.",
          impact: 3,
          source: "http",
        });
      }
      if (parsed.robotsMeta && /noindex/i.test(parsed.robotsMeta)) {
        findings.push({
          category: "seo",
          code: "noindex",
          severity: "critical",
          title: "Page is set to noindex",
          detail: "The page explicitly asks search engines not to index it.",
          recommendation: "Remove the noindex directive if this page should rank.",
          impact: 25,
          evidence: { robots: parsed.robotsMeta },
          source: "http",
        });
      }
      if (!parsed.viewport) {
        findings.push({
          category: "performance",
          code: "missing_viewport",
          severity: "medium",
          title: "No mobile viewport tag",
          detail: "The page does not declare a viewport, so it will not scale correctly on phones.",
          recommendation: "Add a responsive viewport meta tag.",
          impact: 6,
          source: "http",
        });
      }
      if (!parsed.lang) {
        findings.push({
          category: "accessibility",
          code: "missing_lang",
          severity: "low",
          title: "Page language is not declared",
          detail: "Assistive technology cannot determine the page language.",
          recommendation: "Add a lang attribute to the html element.",
          impact: 2,
          source: "http",
        });
      }
      if (parsed.imagesWithoutAlt > 0) {
        findings.push({
          category: "accessibility",
          code: "images_without_alt",
          severity: parsed.imagesWithoutAlt > 10 ? "medium" : "low",
          title: `${parsed.imagesWithoutAlt} images without alt text`,
          detail:
            "Images without alternative text are invisible to screen readers and image search.",
          recommendation: "Add descriptive alt text to every meaningful image.",
          impact: parsed.imagesWithoutAlt > 10 ? 5 : 2,
          source: "http",
        });
      }
      if (parsed.structuredData === 0) {
        findings.push({
          category: "seo",
          code: "no_structured_data",
          severity: "low",
          title: "No structured data found",
          detail: "The page has no JSON-LD markup, so rich results are unlikely.",
          recommendation:
            "Add relevant schema.org JSON-LD (Organization, LocalBusiness, Product…).",
          impact: 4,
          source: "http",
        });
      }
      if (parsed.wordCount < 250) {
        findings.push({
          category: "content",
          code: "thin_content",
          severity: "medium",
          title: `Only ${parsed.wordCount} words of visible text`,
          detail: "Thin pages rarely satisfy search intent.",
          recommendation: "Expand the page with useful, original content.",
          impact: 6,
          source: "http",
        });
      }
    }

    // ---------- Security headers (from the real response) ----------
    const headers = (raw.headers ?? {}) as Record<string, string>;
    const required: {
      key: string;
      label: string;
      severity: Finding["severity"];
      impact: number;
    }[] = [
      { key: "strict-transport-security", label: "HSTS", severity: "medium", impact: 5 },
      {
        key: "content-security-policy",
        label: "Content Security Policy",
        severity: "medium",
        impact: 5,
      },
      {
        key: "x-content-type-options",
        label: "X-Content-Type-Options",
        severity: "low",
        impact: 2,
      },
      { key: "referrer-policy", label: "Referrer-Policy", severity: "low", impact: 2 },
    ];
    for (const item of required) {
      metrics.push({
        category: "security",
        metricKey: item.key,
        valueText: headers[item.key] ?? null,
        source: "http",
      });
      if (!headers[item.key]) {
        findings.push({
          category: "security",
          code: `missing_${item.key}`,
          severity: item.severity,
          title: `${item.label} header is missing`,
          detail: `The server response does not send a ${item.label} header.`,
          recommendation: `Add the ${item.label} response header.`,
          impact: item.impact,
          source: "http",
        });
      }
    }
    if (headers["server"])
      metrics.push({
        category: "security",
        metricKey: "server_header",
        valueText: headers["server"],
        source: "http",
      });
  }

  // ---------- HTTPS ----------
  const tls = by("tls");
  if (tls) {
    metrics.push({
      category: "security",
      metricKey: "https_reachable",
      valueText: tls.status === "completed" ? "yes" : "no",
      source: "tls",
    });
    if (tls.status !== "completed") {
      findings.push({
        category: "security",
        code: "https_unreachable",
        severity: "critical",
        title: "HTTPS is not working",
        detail: tls.errorMessage ?? "A secure connection to the site could not be established.",
        recommendation: "Install a valid TLS certificate and serve the site over HTTPS.",
        impact: 25,
        source: "tls",
      });
    }
  }

  // ---------- DNS ----------
  const dns = by("dns");
  if (dns?.status === "completed") {
    const records = dns.raw as Record<string, string[]>;
    for (const [type, values] of Object.entries(records)) {
      metrics.push({
        category: "dns",
        metricKey: `${type.toLowerCase()}_records`,
        valueNumeric: values.length,
        valueText: values.slice(0, 5).join(", ") || null,
        source: "dns",
      });
    }
    if ((records["A"]?.length ?? 0) === 0 && (records["AAAA"]?.length ?? 0) === 0) {
      findings.push({
        category: "dns",
        code: "no_address_record",
        severity: "critical",
        title: "No A or AAAA record",
        detail: "The domain does not resolve to an IP address.",
        recommendation: "Add an A or AAAA record at your DNS provider.",
        impact: 25,
        source: "dns",
      });
    }
    if ((records["MX"]?.length ?? 0) === 0) {
      findings.push({
        category: "dns",
        code: "no_mx",
        severity: "low",
        title: "No mail (MX) records",
        detail: "This domain cannot receive email.",
        recommendation: "Add MX records if the domain should receive email.",
        impact: 2,
        source: "dns",
      });
    }
    const spf = (records["TXT"] ?? []).some((value) => value.toLowerCase().includes("v=spf1"));
    metrics.push({
      category: "dns",
      metricKey: "spf_present",
      valueText: spf ? "yes" : "no",
      source: "dns",
    });
    if (!spf) {
      findings.push({
        category: "security",
        code: "no_spf",
        severity: "medium",
        title: "No SPF record",
        detail: "Without SPF, anyone can forge email from this domain.",
        recommendation: "Publish an SPF TXT record.",
        impact: 5,
        source: "dns",
      });
    }
    if ((records["CAA"]?.length ?? 0) === 0) {
      findings.push({
        category: "security",
        code: "no_caa",
        severity: "low",
        title: "No CAA record",
        detail: "Any certificate authority can issue certificates for this domain.",
        recommendation: "Publish a CAA record naming your certificate authority.",
        impact: 2,
        source: "dns",
      });
    }
  }

  // ---------- Domain registration ----------
  const rdap = by("rdap");
  if (rdap?.status === "completed" && rdapPayload.parse(rdap.raw).found) {
    const body = rdapPayload.parse(rdap.raw).body;
    const events = body.events;
    const expiry = events.find((event) => event.eventAction === "expiration")?.eventDate ?? null;
    const registered =
      events.find((event) => event.eventAction === "registration")?.eventDate ?? null;
    if (registered)
      metrics.push({
        category: "domain",
        metricKey: "registered_at",
        valueText: registered,
        source: "rdap",
      });
    if (expiry) {
      metrics.push({
        category: "domain",
        metricKey: "expires_at",
        valueText: expiry,
        source: "rdap",
      });
      const days = Math.round((new Date(expiry).getTime() - Date.now()) / 86_400_000);
      metrics.push({
        category: "domain",
        metricKey: "days_to_expiry",
        valueNumeric: days,
        unit: "days",
        source: "rdap",
      });
      if (days < 30) {
        findings.push({
          category: "domain",
          code: "domain_expiring",
          severity: days < 7 ? "critical" : "high",
          title: `Domain expires in ${days} days`,
          detail: "An expired domain takes the whole site and email offline.",
          recommendation: "Renew the domain registration now.",
          impact: days < 7 ? 20 : 10,
          evidence: { expiry },
          source: "rdap",
        });
      }
    }
    if (Array.isArray(body.status))
      metrics.push({
        category: "domain",
        metricKey: "status",
        valueText: body.status.join(", "),
        source: "rdap",
      });
  }

  // ---------- Crawl directives ----------
  const crawl = by("crawl_directives");
  if (crawl?.status === "completed") {
    const raw = directivesPayload.parse(crawl.raw);
    metrics.push({
      category: "seo",
      metricKey: "robots_txt",
      valueText: raw.robotsFound ? "found" : "missing",
      source: "crawl_directives",
    });
    if (!raw.robotsFound) {
      findings.push({
        category: "seo",
        code: "missing_robots",
        severity: "low",
        title: "robots.txt is missing",
        detail: "Crawlers have no crawl instructions for this site.",
        recommendation: "Publish a robots.txt file that links to your sitemap.",
        impact: 2,
        source: "crawl_directives",
      });
    }
    const sitemap = raw.sitemap as {
      httpStatus: number;
      urlCount: number | null;
      url: string;
    } | null;
    if (sitemap && sitemap.httpStatus < 400 && sitemap.urlCount !== null) {
      metrics.push({
        category: "seo",
        metricKey: "sitemap_urls",
        valueNumeric: sitemap.urlCount,
        valueText: sitemap.url,
        source: "crawl_directives",
      });
    } else {
      findings.push({
        category: "seo",
        code: "missing_sitemap",
        severity: "medium",
        title: "No XML sitemap found",
        detail: "Search engines have no sitemap listing the pages of this site.",
        recommendation: "Publish /sitemap.xml and reference it from robots.txt.",
        impact: 5,
        source: "crawl_directives",
      });
    }
  }

  // ---------- PageSpeed (only when Google actually returned data) ----------
  const psi = by("pagespeed");
  if (psi?.status === "completed") {
    const raw = pageSpeedPayload.parse(psi.raw);
    for (const [key, value] of Object.entries(raw.categories ?? {})) {
      if (typeof value === "number") {
        metrics.push({
          category: "performance",
          metricKey: `lighthouse_${key}`,
          valueNumeric: Math.round(value * 100),
          unit: "score",
          source: "pagespeed",
        });
        if (value < 0.5) {
          findings.push({
            category: "performance",
            code: `lighthouse_${key}_low`,
            severity: "high",
            title: `Low Lighthouse ${key.replace(/-/g, " ")} score (${Math.round(value * 100)}/100)`,
            detail: "Google's own measurement rates this area as poor on mobile.",
            recommendation:
              "Work through the PageSpeed Insights recommendations for this category.",
            impact: 8,
            source: "pagespeed",
          });
        }
      }
    }
    for (const [key, value] of Object.entries(raw.metrics ?? {})) {
      if (typeof value === "number")
        metrics.push({
          category: "performance",
          metricKey: key,
          valueNumeric: Math.round(value),
          unit: "ms",
          source: "pagespeed",
        });
    }
  }

  // ---------- Multi-page crawl (real pages fetched from this site) ----------
  const crawled = by("crawl");
  if (crawled?.status === "completed") {
    const raw = crawlPayload.parse(crawled.raw);
    const pages = raw.pages;
    metrics.push({
      category: "crawl",
      metricKey: "pages_crawled",
      valueNumeric: pages.length,
      source: "crawl",
    });
    metrics.push({
      category: "crawl",
      metricKey: "internal_urls_discovered",
      valueNumeric: raw.discoveredInternalUrls ?? 0,
      source: "crawl",
    });
    metrics.push({
      category: "crawl",
      metricKey: "links_checked",
      valueNumeric: (raw.linkChecks ?? []).length,
      source: "crawl",
    });

    const broken = raw.brokenLinks;
    metrics.push({
      category: "crawl",
      metricKey: "broken_links",
      valueNumeric: broken.length,
      source: "crawl",
    });
    if (broken.length) {
      findings.push({
        category: "crawl",
        code: "broken_links",
        severity: broken.length > 3 ? "high" : "medium",
        title: `${broken.length} broken link${broken.length === 1 ? "" : "s"} found`,
        detail: "These addresses were checked and did not return a working page.",
        recommendation:
          "Fix or remove the broken links so visitors and crawlers do not hit dead ends.",
        impact: Math.min(10, broken.length * 2),
        evidence: { brokenLinks: broken.slice(0, 10) },
        source: "crawl",
      });
    }

    const duplicates = Number(raw.duplicateTitles ?? 0);
    metrics.push({
      category: "crawl",
      metricKey: "duplicate_titles",
      valueNumeric: duplicates,
      source: "crawl",
    });
    if (duplicates > 0) {
      findings.push({
        category: "crawl",
        code: "duplicate_titles",
        severity: "medium",
        title: `${duplicates} crawled page${duplicates === 1 ? "" : "s"} share a title with another page`,
        detail: "Duplicate titles make pages compete with each other in search results.",
        recommendation: "Give every page a unique, descriptive title.",
        impact: Math.min(6, duplicates * 2),
        evidence: { pages: pages.map((p) => ({ url: p.url, title: p.title })).slice(0, 10) },
        source: "crawl",
      });
    }

    const noindexPages = pages.filter((page) => page.noindex);
    if (noindexPages.length) {
      findings.push({
        category: "crawl",
        code: "crawled_noindex_pages",
        severity: "high",
        title: `${noindexPages.length} crawled page${noindexPages.length === 1 ? " is" : "s are"} blocked from search`,
        detail: "These pages tell search engines not to index them.",
        recommendation: "Remove the noindex directive from pages that should appear in search.",
        impact: Math.min(12, noindexPages.length * 4),
        evidence: { pages: noindexPages.map((p) => p.url).slice(0, 10) },
        source: "crawl",
      });
    }

    const errorPages = pages.filter((page) => page.httpStatus >= 400);
    if (errorPages.length) {
      findings.push({
        category: "crawl",
        code: "crawl_error_pages",
        severity: "high",
        title: `${errorPages.length} crawled page${errorPages.length === 1 ? "" : "s"} returned an error`,
        detail: "Pages linked from this site did not load successfully.",
        recommendation: "Repair or remove the links to these pages.",
        impact: Math.min(12, errorPages.length * 4),
        evidence: {
          pages: errorPages.map((p) => ({ url: p.url, httpStatus: p.httpStatus })).slice(0, 10),
        },
        source: "crawl",
      });
    }

    const missingDescriptions = pages.filter((page) => !page.description);
    if (missingDescriptions.length > 1) {
      findings.push({
        category: "crawl",
        code: "crawl_missing_descriptions",
        severity: "low",
        title: `${missingDescriptions.length} crawled pages have no meta description`,
        detail: "Search engines will write their own snippet for these pages.",
        recommendation: "Add a unique meta description to each page.",
        impact: 3,
        evidence: { pages: missingDescriptions.map((p) => p.url).slice(0, 10) },
        source: "crawl",
      });
    }

    const slowest = pages.reduce<(typeof pages)[number] | null>(
      (worst, page) => (worst && worst.durationMs > page.durationMs ? worst : page),
      null,
    );
    if (slowest)
      metrics.push({
        category: "performance",
        metricKey: "slowest_crawled_page_ms",
        valueNumeric: slowest.durationMs,
        valueText: slowest.url,
        unit: "ms",
        source: "crawl",
      });
    if (Array.isArray(raw.blockedByRobots) && raw.blockedByRobots.length) {
      metrics.push({
        category: "crawl",
        metricKey: "robots_disallow_rules",
        valueNumeric: raw.blockedByRobots.length,
        valueText: raw.blockedByRobots.slice(0, 5).join(", "),
        source: "crawl",
      });
    }
  }

  // ---------- Score: 100 minus the impact of what was actually found ----------
  const deductions = findings.reduce((total, finding) => total + finding.impact, 0);

  const measurable = sources.some((source) => source.status === "completed");
  const score = measurable ? Math.max(0, Math.min(100, 100 - deductions)) : null;

  const categories = Array.from(new Set(findings.map((finding) => finding.category)));
  const categoryScores: Record<string, number> = {};
  for (const category of categories) {
    const impact = findings
      .filter((finding) => finding.category === category)
      .reduce((total, finding) => total + finding.impact, 0);
    categoryScores[category] = Math.max(0, 100 - impact * 2);
  }

  return { metrics, findings, score, categoryScores };
}
