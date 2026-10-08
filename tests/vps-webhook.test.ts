import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createDeploymentWebhook } from "../scripts/vps-webhook.mjs";

describe("VPS deployment webhook", () => {
  const secret = "webhook-unit-test-secret";
  const commit = "a".repeat(40);
  const deployed: string[] = [];
  let release: (() => void) | undefined;
  const server = createDeploymentWebhook({
    secret,
    deploy: (sha: string) =>
      new Promise<void>((resolve) => {
        deployed.push(sha);
        release = resolve;
      }),
  });
  let endpoint: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind.");
    endpoint = `http://127.0.0.1:${address.port}/__deploy`;
  });

  afterAll(() => {
    release?.();
    server.closeAllConnections();
    server.close();
  });

  async function send(body: string, event = "push", signature?: string) {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-hub-signature-256":
          signature ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
  }

  function payload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      repository: { full_name: "theseovala/seovale" },
      ref: "refs/heads/main",
      after: commit,
      ...overrides,
    });
  }

  test("rejects malformed and invalid signatures without deploying", async () => {
    expect((await send(payload(), "push", "sha256=invalid")).status).toBe(401);
    expect((await send(payload(), "push", `sha256=${"0".repeat(64)}`)).status).toBe(401);
    expect(deployed).toEqual([]);
  });

  test("rejects invalid signed JSON and wrong repository", async () => {
    expect((await send("{")).status).toBe(400);
    expect((await send(payload({ repository: { full_name: "unrelated/project" } }))).status).toBe(
      403,
    );
    expect(deployed).toEqual([]);
  });

  test("ping, feature branches, deletions and non-push events never deploy", async () => {
    expect((await send("{}", "ping")).status).toBe(200);
    expect((await send(payload({ ref: "refs/heads/fix/example" }))).status).toBe(200);
    expect((await send(payload({ deleted: true }))).status).toBe(200);
    expect((await send(payload(), "pull_request")).status).toBe(200);
    expect(deployed).toEqual([]);
  });

  test("rejects missing, zero and shell-injection commit values", async () => {
    for (const after of [null, "", "0".repeat(40), "main; echo invalid"]) {
      expect((await send(payload({ after }))).status).toBe(400);
    }
    expect(deployed).toEqual([]);
  });

  test("passes only the full commit and prevents overlapping deploys", async () => {
    expect((await send(payload())).status).toBe(202);
    expect(deployed).toEqual([commit]);
    expect((await send(payload())).status).toBe(409);
    expect(deployed).toEqual([commit]);
    release?.();
  });
});
