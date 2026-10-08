import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function createDeploymentWebhook({ secret, deploy }) {
  let running = false;
  return createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/__deploy") {
      res.writeHead(404).end("not found");
      return;
    }
    let raw = "";
    let oversized = false;
    req.on("data", (chunk) => {
      if (oversized) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > 5e6) {
        oversized = true;
        raw = "";
        res.writeHead(413).end("payload too large");
      }
    });
    req.on("end", () => {
      if (oversized) return;
      if (!secret) {
        res.writeHead(500).end("secret not configured");
        return;
      }
      const signature = req.headers["x-hub-signature-256"];
      if (typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
        res.writeHead(401).end("missing or invalid signature");
        return;
      }
      const expected = createHmac("sha256", secret).update(raw).digest();
      if (!timingSafeEqual(Buffer.from(signature.slice(7), "hex"), expected)) {
        res.writeHead(401).end("bad signature");
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      if (req.headers["x-github-event"] === "ping") {
        res.writeHead(200).end("pong");
        return;
      }
      if (body?.repository?.full_name !== "theseovala/seovale") {
        res.writeHead(403).end("wrong repository");
        return;
      }
      if (
        req.headers["x-github-event"] !== "push" ||
        body?.ref !== "refs/heads/main" ||
        body.deleted
      ) {
        res.writeHead(200).end("ignored: not a production push");
        return;
      }
      if (
        typeof body.after !== "string" ||
        !/^[0-9a-f]{40}$/.test(body.after) ||
        /^0+$/.test(body.after)
      ) {
        res.writeHead(400).end("invalid commit");
        return;
      }
      if (running) {
        res.writeHead(409).end("a deploy is already running");
        return;
      }
      running = true;
      res.writeHead(202).end("deploy accepted for " + body.after.slice(0, 7));
      Promise.resolve()
        .then(() => deploy(body.after))
        .catch((error) => console.error(`Deployment failed for ${body.after}:`, error))
        .finally(() => {
          running = false;
        });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not configured.");
  createDeploymentWebhook({
    secret,
    deploy: (commit) =>
      new Promise((resolve, reject) => {
        const child = spawn("/opt/seovale-deploy/run-vps-release.sh", [commit], {
          stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`Release runner exited ${code ?? signal}.`));
        });
      }),
  }).listen(9000, "127.0.0.1", () => console.log("hook listening on 127.0.0.1:9000"));
}
