import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
  console.warn(
    "[e2e-projects-write] skipping: conda env 'arclight' or arclight_core not importable",
  );

const PY_PORT = freePort();
const TOKEN = "test-token-456";
let py: ReturnType<typeof Bun.spawn> | undefined;
let tsUpstream: ReturnType<typeof Bun.serve> | undefined;
let workdir: string;

async function waitForPython(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200 || r.status === 401) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`python server did not become ready at ${url}`);
}

beforeAll(async () => {
  if (!E2E_AVAILABLE) return;
  workdir = mkdtempSync(join(tmpdir(), "arc-e2e-projw-"));
  const dbPath = join(workdir, "arclight.sqlite");
  // Seed: workspace w1 (+ a completed-turn session so DELETE cascade has something to clear).
  const seed = Bun.spawnSync(
    [
      "conda",
      "run",
      "-n",
      "arclight",
      "python",
      "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, repo_path TEXT NOT NULL)")
c.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE)")
c.execute("CREATE TABLE turns (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE)")
c.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w1','alpha','/p/alpha')")
c.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w2','gamma','/p/gamma')")
c.execute("INSERT INTO sessions (id,workspace_id) VALUES ('s1','w1')")
c.execute("INSERT INTO turns (id,session_id,status) VALUES ('t1','s1','completed')")
c.commit(); c.close()`,
      dbPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (seed.exitCode !== 0) throw new Error(`seed failed: ${seed.stderr}`);

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
        ARCLIGHT_PROJECTS_ROOT: workdir,
        ARCLIGHT_TOKEN: TOKEN,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await waitForPython(`http://localhost:${PY_PORT}/health`);

  // TS upstream stub: stands in for the not-migrated GET /:id/sessions (M3) and POST create.
  tsUpstream = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname.endsWith("/sessions")) {
        return Response.json({ via: "ts-sessions" });
      }
      if (req.method === "POST" && u.pathname === "/api/projects") {
        return Response.json({ via: "ts-create" });
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

describe.skipIf(!E2E_AVAILABLE)("cross-runtime seam: workspaces writes", () => {
  function proxy() {
    return makeProxy({
      table: {
        "=/api/projects": { GET: "py", default: "ts" },
        "/api/projects": { PATCH: "py", DELETE: "py", default: "ts" },
      },
      tsUpstream: `http://localhost:${tsUpstream!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
  }
  const auth = { Authorization: `Bearer ${TOKEN}` };

  test("authed PATCH renames via the real Python server", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects/w1", {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // confirm it landed in the DB via Python's GET
    const get = await proxy()(new Request("http://proxy/api/projects", { headers: auth }));
    const body = (await get.json()) as { projects: { workspaceId: string; name: string }[] };
    expect(body.projects.find((p) => p.workspaceId === "w1")?.name).toBe("renamed");
  });

  test("missing token is rejected by Python auth (401)", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects/w1", { method: "PATCH", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  test("GET /api/projects/:id/sessions still routes to TS", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects/w1/sessions", { headers: auth }),
    );
    expect(await res.json()).toEqual({ via: "ts-sessions" });
  });

  test("POST /api/projects (create) still routes to TS", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects", { method: "POST", headers: auth }),
    );
    expect(await res.json()).toEqual({ via: "ts-create" });
  });

  test("authed DELETE unregisters via Python + cascades", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects/w2", { method: "DELETE", headers: auth }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const get = await proxy()(new Request("http://proxy/api/projects", { headers: auth }));
    const body = (await get.json()) as { projects: { workspaceId: string }[] };
    expect(body.projects.find((p) => p.workspaceId === "w2")).toBeUndefined();
  });
});
