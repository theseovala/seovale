import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/package-release.mjs", import.meta.url));

describe("Release packaging CLI", () => {
  test.each([true, false])(
    "retains client source and cleans stages (upload succeeds: %s)",
    async (ok) => {
      const root = mkdtempSync(join(tmpdir(), "seovale-packaging-test-"));
      const source = join(root, "source");
      const stageRoot = join(root, "stages");
      mkdirSync(stageRoot);
      const files = [
        "src/integrations/supabase/client.ts",
        "src/.env.local",
        "public/robots.txt",
        "package.json",
        "bun.lock",
        "bunfig.toml",
        "components.json",
        "tsconfig.json",
        "vite.config.ts",
        "eslint.config.js",
        "README.md",
      ];
      for (const file of files) {
        const path = join(source, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.endsWith(".json") ? "{}" : "unit-test fixture");
      }
      const uploads: string[] = [];
      let artifact: Uint8Array | undefined;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/storage/v1/bucket/license-releases") {
            return Response.json({ id: "license-releases", public: false });
          }
          uploads.push(path);
          if (!ok)
            return Response.json({ error: "deliberate unit upload failure" }, { status: 500 });
          if (path.endsWith(".tar.gz")) artifact = new Uint8Array(await request.arrayBuffer());
          return Response.json({ uploaded: true });
        },
      });
      try {
        const child = Bun.spawn(["node", script, "1.2.3", "unit-build"], {
          cwd: source,
          env: {
            ...process.env,
            SUPABASE_URL: server.url.toString(),
            SUPABASE_SERVICE_ROLE_KEY: "unit-service-key",
            TMP: stageRoot,
            TEMP: stageRoot,
            TMPDIR: stageRoot,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(readdirSync(stageRoot)).toEqual([]);
        expect(uploads.length).toBe(ok ? 2 : 1);
        if (ok) {
          expect(exit).toBe(0);
          expect(JSON.parse(stdout).inspection).toBe("passed");
          if (!artifact) throw new Error("Expected a real packaged unit artifact.");
          const archive = join(root, "artifact.tar.gz");
          writeFileSync(archive, artifact);
          const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
          expect(entries).toContain("src/integrations/supabase/client.ts");
          expect(entries).not.toContain(".env.local");
        } else {
          expect(exit).not.toBe(0);
          expect(stderr).toContain("Upload failed");
          expect(stdout).not.toContain('"inspection": "passed"');
        }
      } finally {
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
