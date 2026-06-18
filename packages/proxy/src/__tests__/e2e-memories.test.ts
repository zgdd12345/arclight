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
  console.warn("[e2e-memories] skipping: conda env 'arclight' or arclight_core not importable");

const PY_PORT = freePort();
const TOKEN = "test-token-mem";
let py: ReturnType<typeof Bun.spawn> | undefined;
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
  workdir = mkdtempSync(join(tmpdir(), "arc-e2e-mem-"));
  const dbPath = join(workdir, "arclight.sqlite");
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
c.execute("CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, content TEXT NOT NULL, enabled integer DEFAULT true NOT NULL, created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)")
c.commit(); c.close()`,
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
        ARCLIGHT_PROJECTS_ROOT: workdir,
        ARCLIGHT_TOKEN: TOKEN,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await waitForPython(`http://localhost:${PY_PORT}/health`);
});

afterAll(() => {
  if (!E2E_AVAILABLE) return;
  py?.kill();
  Bun.spawn(["pkill", "-f", `arclight_core.server.app:app --port ${PY_PORT}`]);
});

describe.skipIf(!E2E_AVAILABLE)("cross-runtime seam: /api/memories CRUD", () => {
  function proxy() {
    return makeProxy({
      table: { "/api/memories": "py" },
      tsUpstream: "http://localhost:1", // unused — every memories method routes to py
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
  }
  const auth = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  test("create → list → update → delete via real Python", async () => {
    // create
    const created = await proxy()(
      new Request("http://proxy/api/memories", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ content: "alpha" }),
      }),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    expect(id).toBeTruthy();

    // list
    const listed = await proxy()(new Request("http://proxy/api/memories", { headers: auth }));
    const memBody = (await listed.json()) as {
      memories: { id: string; content: string; enabled: boolean }[];
    };
    const found = memBody.memories.find((m) => m.id === id);
    expect(found).toEqual({
      id,
      content: "alpha",
      enabled: true,
      createdAt: found!.createdAt,
    } as never);

    // update (disable + edit)
    const patched = await proxy()(
      new Request(`http://proxy/api/memories/${id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ content: "beta", enabled: false }),
      }),
    );
    expect(patched.status).toBe(200);
    const after = (await (
      await proxy()(new Request("http://proxy/api/memories", { headers: auth }))
    ).json()) as { memories: { id: string; content: string; enabled: boolean }[] };
    expect(after.memories.find((m) => m.id === id)).toMatchObject({
      content: "beta",
      enabled: false,
    });

    // delete
    const del = await proxy()(
      new Request(`http://proxy/api/memories/${id}`, { method: "DELETE", headers: auth }),
    );
    expect(del.status).toBe(200);
    const final = (await (
      await proxy()(new Request("http://proxy/api/memories", { headers: auth }))
    ).json()) as { memories: { id: string }[] };
    expect(final.memories.find((m) => m.id === id)).toBeUndefined();
  });

  test("missing token is rejected by Python auth (401)", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/memories", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });
});
