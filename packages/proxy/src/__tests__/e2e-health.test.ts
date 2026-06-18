import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeProxy } from "../server";

// Boot the REAL Python health app under uvicorn on a dynamically-allocated port,
// plus a fake TS upstream, and route through the real proxy handler.
// NOTE: This suite requires the `arclight` conda env with arclight_core installed.

// Grab a free port by opening an ephemeral listener and immediately closing it.
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop();
  return p;
}
const PY_PORT = freePort();
const repoRoot = new URL("../../../../", import.meta.url).pathname; // packages/proxy/src/__tests__ -> repo root

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
  console.warn("[e2e-health] skipping: conda env 'arclight' or arclight_core not importable");

let py: ReturnType<typeof Bun.spawn> | undefined;
let tsUpstreamServer: ReturnType<typeof Bun.serve> | undefined;

async function waitForPython(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`python health server did not become ready at ${url}`);
}

beforeAll(async () => {
  if (!E2E_AVAILABLE) return;
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
    { cwd: repoRoot, stdout: "ignore", stderr: "ignore" },
  );
  await waitForPython(`http://localhost:${PY_PORT}/health`);

  tsUpstreamServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/config") return Response.json({ via: "ts" });
      return new Response("nope", { status: 404 });
    },
  });
});

afterAll(async () => {
  if (!E2E_AVAILABLE) return;
  py?.kill();
  // `conda run` does not propagate signals to its Python grandchild; explicitly
  // kill the uvicorn process by matching the module path so nothing leaks.
  try {
    const pkill = Bun.spawn(["pkill", "-f", `arclight_core.server.app:app --port ${PY_PORT}`]);
    await pkill.exited;
  } catch {
    // nothing to kill — fine
  }
  tsUpstreamServer?.stop(true);
});

describe.skipIf(!E2E_AVAILABLE)("cross-runtime seam", () => {
  test("/health is served by the real Python app through the proxy", async () => {
    const proxy = makeProxy({
      table: { "/health": "py", "/api/config": "ts" },
      tsUpstream: `http://localhost:${tsUpstreamServer!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
    const res = await proxy(new Request("http://proxy/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("arclight-core"); // came from the Python app
  });

  test("/api/* still reaches the TS upstream through the proxy", async () => {
    const proxy = makeProxy({
      table: { "/health": "py", "/api/config": "ts" },
      tsUpstream: `http://localhost:${tsUpstreamServer!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
    const res = await proxy(new Request("http://proxy/api/config"));
    expect(await res.json()).toEqual({ via: "ts" });
  });
});
