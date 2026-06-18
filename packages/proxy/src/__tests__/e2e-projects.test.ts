import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProxy } from "../server";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop();
  return p;
}

function arclightEnvAvailable(): boolean {
  try {
    const probe = Bun.spawnSync(
      ["conda", "run", "-n", "arclight", "python", "-c", "import arclight_core.server.app"],
      {
        cwd: repoRoot,
        env: { ...process.env, PYTHONPATH: `${repoRoot}packages/core-py/src` },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}
const E2E_AVAILABLE = arclightEnvAvailable();
if (!E2E_AVAILABLE)
  console.warn("[e2e-projects] skipping: conda env 'arclight' or arclight_core not importable");

const PY_PORT = freePort();
const TOKEN = "test-token-123";
let py: ReturnType<typeof Bun.spawn> | undefined;
let tsUpstream: ReturnType<typeof Bun.serve> | undefined;
let workdir: string;

async function waitForPython(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200 || r.status === 401) return; // server up (401 = auth gate reached)
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`python server did not become ready at ${url}`);
}

beforeAll(async () => {
  if (!E2E_AVAILABLE) return;
  // Seed a SQLite workspaces table + a projects root with one available dir.
  workdir = mkdtempSync(join(tmpdir(), "arc-e2e-proj-"));
  const dbPath = join(workdir, "arclight.sqlite");
  const projectsRoot = join(workdir, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(join(projectsRoot, "beta"));
  const seed = Bun.spawnSync(
    [
      "conda",
      "run",
      "-n",
      "arclight",
      "python",
      "-c",
      `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"); c.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('ws1','alpha','/projects/alpha')"); c.commit(); c.close()`,
      dbPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (seed.exitCode !== 0) throw new Error(`seed failed: ${new TextDecoder().decode(seed.stderr)}`);

  py = Bun.spawn(
    [
      "conda",
      "run",
      "-n",
      "arclight",
      "python",
      "-m",
      "uvicorn",
      "arclight_core.server.app:app",
      "--port",
      String(PY_PORT),
      "--app-dir",
      "packages/core-py/src",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ARCLIGHT_DB_PATH: dbPath,
        ARCLIGHT_PROJECTS_ROOT: projectsRoot,
        ARCLIGHT_TOKEN: TOKEN,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await waitForPython(`http://localhost:${PY_PORT}/health`);

  tsUpstream = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/api/projects") {
        return Response.json({ via: "ts-write" });
      }
      return new Response("nope", { status: 404 });
    },
  });
});

afterAll(() => {
  if (!E2E_AVAILABLE) return;
  py?.kill();
  Bun.spawn(["pkill", "-f", `arclight_core.server.app:app --port ${PY_PORT}`]);
  tsUpstream?.stop(true);
});

describe.skipIf(!E2E_AVAILABLE)("cross-runtime seam: GET /api/projects", () => {
  function proxy() {
    return makeProxy({
      table: { "/api/projects": { GET: "py", default: "ts" } },
      tsUpstream: `http://localhost:${tsUpstream!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
  }

  test("authed GET is served by the real Python server", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projects: { workspaceId: string; name: string; repoPath: string }[];
      available: { name: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.projects).toEqual([
      { workspaceId: "ws1", name: "alpha", repoPath: "/projects/alpha" },
    ]);
    expect(body.available.map((d) => d.name)).toContain("beta");
  });

  test("missing token is rejected by Python auth (401)", async () => {
    const res = await proxy()(new Request("http://proxy/api/projects"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
  });

  test("POST /api/projects still routes to TS", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await res.json()).toEqual({ via: "ts-write" });
  });
});
