import { z } from "zod";

const numeric = z.number().finite().nullable().catch(null);
const text = z.string().nullable().catch(null);
const link = z.object({ url: z.string(), httpStatus: z.number(), error: z.string().optional() });
const page = z.object({
  url: z.string(),
  httpStatus: z.number(),
  durationMs: z.number(),
  title: text,
  description: text,
  noindex: z.boolean().catch(false),
});

export const httpPayload = z.object({
  httpStatus: numeric,
  bytes: numeric,
  finalUrl: text,
  html: z.string().catch(""),
  headers: z.record(z.string(), z.string()).catch({}),
});

export const directivesPayload = z.object({
  robotsFound: z.boolean().catch(false),
  sitemap: z
    .object({ httpStatus: z.number(), urlCount: numeric, url: z.string() })
    .nullable()
    .catch(null),
});

export const pageSpeedPayload = z.object({
  categories: z.record(z.string(), numeric).catch({}),
  metrics: z.record(z.string(), numeric).catch({}),
});

export const crawlPayload = z.object({
  pages: z.array(page).catch([]),
  pagesCrawled: numeric,
  discoveredInternalUrls: numeric,
  linkChecks: z.array(link).catch([]),
  brokenLinks: z.array(link).catch([]),
  duplicateTitles: numeric,
  blockedByRobots: z.array(z.string()).catch([]),
});

export const rdapPayload = z.object({
  found: z.boolean().catch(false),
  body: z
    .object({
      events: z
        .array(z.object({ eventAction: z.string().optional(), eventDate: z.string().optional() }))
        .catch([]),
      status: z.array(z.string()).catch([]),
    })
    .catch({ events: [], status: [] }),
});
