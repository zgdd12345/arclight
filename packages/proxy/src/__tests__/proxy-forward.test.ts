import { afterAll, describe, expect, test } from "bun:test";
import { makeProxy } from "../server";

// Fake TS upstream: one plain JSON route + one SSE route + one hop-by-hop probe.
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, via: "ts", got: req.headers.get("x-test") });
    }
    if (url.pathname === "/api/sessions/s1/events") {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: one\n\n"));
          c.enqueue(new TextEncoder().encode("data: two\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/probe") {
      const compressed = Bun.gzipSync(new TextEncoder().encode('{"x":1}'));
      return new Response(compressed, {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "999",
        },
      });
    }
    return new Response("nope", { status: 404 });
  },
});
const tsUpstream = `http://localhost:${upstream.port}`;
const proxy = makeProxy({
  table: { "/api/health": "ts", "/api/sessions": "ts", "/api/probe": "ts" },
  tsUpstream,
});

afterAll(() => upstream.stop(true));

describe("proxy forwarding", () => {
  test("forwards JSON + preserves headers", async () => {
    const res = await proxy(new Request("http://proxy/api/health", { headers: { "x-test": "v" } }));
    const body = await res.json();
    expect(body).toEqual({ ok: true, via: "ts", got: "v" });
  });

  test("passes through SSE stream unbuffered", async () => {
    const res = await proxy(new Request("http://proxy/api/sessions/s1/events"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
  });

  test("strips hop-by-hop headers but preserves content-type", async () => {
    const res = await proxy(new Request("http://proxy/api/probe"));
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
  });
});
