import { describe, expect, test } from "bun:test";
import { requirePrivateReleaseBucket } from "../scripts/release-storage.mjs";

describe("Release storage preflight", () => {
  test("accepts only the required private bucket", async () => {
    const request: typeof fetch = async (input, options) => {
      expect(String(input)).toBe("https://example.supabase.co/storage/v1/bucket/license-releases");
      expect(new Headers(options?.headers).get("apikey")).toBe("test-service-key");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer test-service-key");
      return Response.json({ id: "license-releases", public: false });
    };
    await requirePrivateReleaseBucket("https://example.supabase.co", "test-service-key", request);
  });

  test.each([400, 401, 403, 500])("fails explicitly on HTTP %s", async (status) => {
    await expect(
      requirePrivateReleaseBucket("https://example.supabase.co", "test-service-key", async () =>
        Response.json({ error: "unavailable" }, { status }),
      ),
    ).rejects.toThrow(`HTTP ${status}`);
  });

  test.each([
    { id: "license-releases", public: true },
    { id: "different-bucket", public: false },
    { id: "license-releases" },
  ])("rejects public or invalid metadata %j", async (bucket) => {
    await expect(
      requirePrivateReleaseBucket("https://example.supabase.co", "test-service-key", async () =>
        Response.json(bucket),
      ),
    ).rejects.toThrow("must be a private bucket");
  });

  test("does not hide transport failure", async () => {
    await expect(
      requirePrivateReleaseBucket("https://example.supabase.co", "test-service-key", async () => {
        throw new Error("network disconnected");
      }),
    ).rejects.toThrow("network disconnected");
  });
});
