// Archive fixtures stay in memory; never uploaded or stored as releases.
import { expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { inspectReleaseZip } from "../src/lib/license/archive.server";

test("inspects actual ZIP entries", () => {
  const result = inspectReleaseZip(zipSync({ "dist/client.js": strToU8("fixture") }));
  expect(result.entries).toEqual(["dist/client.js"]);
});
test("rejects secrets inside the actual archive", () => {
  expect(() => inspectReleaseZip(zipSync({ ".env": strToU8("fixture") }))).toThrow("forbidden");
});
test("rejects path traversal", () => {
  expect(() => inspectReleaseZip(zipSync({ "../client.js": strToU8("fixture") }))).toThrow("Unsafe");
});
test("rejects empty archives", () => {
  expect(() => inspectReleaseZip(zipSync({}))).toThrow("empty");
});