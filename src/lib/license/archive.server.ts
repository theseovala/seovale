import { unzipSync } from "fflate";
import { inspectArtifactEntries } from "./operations.server";

export function inspectReleaseZip(bytes: Uint8Array) {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Release ZIP must be 20 MB or smaller.");
  let total = 0;
  const entries: string[] = [];
  unzipSync(bytes, { filter: (entry) => {
    total += entry.originalSize;
    if (total > 80 * 1024 * 1024 || entries.length >= 5000) throw new Error("Release archive exceeds inspection limits.");
    if (entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").includes("..")) throw new Error("Unsafe archive path.");
    entries.push(entry.name);
    return false;
  } });
  if (!entries.some((entry) => !entry.endsWith("/"))) throw new Error("Release archive is empty.");
  const inspection = inspectArtifactEntries(entries);
  if (!inspection.passed) throw new Error(`Release blocked: forbidden files (${inspection.violations.slice(0, 5).join(", ")}).`);
  return { entries, inspection };
}