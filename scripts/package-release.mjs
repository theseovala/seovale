#!/usr/bin/env node
/**
 * Owner-only release packaging.
 *
 * SOURCE -> STAGE (forbidden entries removed) -> INSPECT -> PACKAGE -> UPLOAD.
 *
 * The artifact and its manifest are uploaded to the private `license-releases`
 * bucket. Publishing (checksum re-hash, inspection re-run, signing) happens
 * server-side through the Licensing panel — this script never signs anything
 * and never embeds a secret in the package.
 *
 * Usage: node scripts/package-release.mjs <version> [buildId]
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requirePrivateReleaseBucket } from "./release-storage.mjs";

const version = process.argv[2];
const buildId = process.argv[3] ?? `build-${Date.now()}`;
if (!version) {
  console.error("Usage: node scripts/package-release.mjs <version> [buildId]");
  process.exit(1);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version)) {
  throw new Error("Version must be a path-safe identifier of at most 40 characters.");
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
await requirePrivateReleaseBucket(SUPABASE_URL, SERVICE_KEY);

// Anything matching these never leaves the master repository.
const EXCLUDE = [
  ".git",
  ".github",
  ".env",
  ".env.*",
  ".npmrc",
  "node_modules",
  ".lovable",
  ".workspace",
  ".agents",
  ".claude",
  "scripts",
  "docs",
  "roadmap.md",
  "*.pem",
  "*.key",
  "id_rsa*",
  "*.log",
  "tsconfig.tsbuildinfo",
];

const INCLUDE = [
  "src",
  "public",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "components.json",
  "tsconfig.json",
  "vite.config.ts",
  "eslint.config.js",
  "README.md",
];

const stage = mkdtempSync(join(tmpdir(), "seovale-release-"));
try {
  const artifactName = `seovale-${version}.tar.gz`;
  const artifactPath = join(stage, artifactName);

  const tarArgs = ["-czf", artifactPath];
  for (const pattern of EXCLUDE) tarArgs.push(`--exclude=${pattern}`);
  tarArgs.push(...INCLUDE);
  execFileSync("tar", tarArgs, { cwd: process.cwd(), stdio: "inherit" });

  const entries = execFileSync("tar", ["-tzf", artifactPath], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Local pre-flight inspection; the server repeats this before publishing.
  const FORBIDDEN = [
    /(^|\/)\.git(\/|$)/,
    /(^|\/)\.env/,
    /\.npmrc$/,
    /\.pem$/,
    /\.key$/,
    /id_rsa/,
    /(^|\/)\.github(\/|$)/,
    /^supabase(\/|$)/,
    /service[-_]?role/i,
  ];
  const violations = entries.filter((entry) => FORBIDDEN.some((pattern) => pattern.test(entry)));
  if (violations.length > 0) {
    console.error("Artifact inspection failed. Forbidden entries:");
    for (const entry of violations.slice(0, 20)) console.error(`  ${entry}`);
    throw new Error("Artifact inspection failed; no release was uploaded.");
  }

  const manifest = {
    version,
    buildId,
    createdAt: new Date().toISOString(),
    entryCount: entries.length,
    entries,
  };
  const manifestPath = join(stage, `${artifactName}.manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const objectPath = `${version}/${artifactName}`;
  async function upload(path, body, contentType) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/license-releases/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
        "content-type": contentType,
        "x-upsert": "true",
      },
      body,
    });
    if (!response.ok)
      throw new Error(`Upload failed for ${path}: ${response.status} ${await response.text()}`);
  }

  await upload(objectPath, readFileSync(artifactPath), "application/gzip");
  await upload(`${objectPath}.manifest.json`, readFileSync(manifestPath), "application/json");

  console.log(
    JSON.stringify(
      {
        artifactPath: objectPath,
        version,
        buildId,
        bytes: statSync(artifactPath).size,
        entries: entries.length,
        inspection: "passed",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
