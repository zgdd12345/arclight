// Transparent reverse proxy in front of /api/*. Forwards to the upstream chosen
// by the route table, streaming the response body so SSE is never buffered.
import { DEFAULT_TABLE, type RouteTable, resolveUpstream } from "./route-table";

export type ProxyOpts = {
  table: RouteTable;
  tsUpstream: string;
  pyUpstream?: string;
};

export function makeProxy(opts: ProxyOpts): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const target = resolveUpstream(url.pathname, opts.table, req.method);
    const base = target === "py" ? opts.pyUpstream : opts.tsUpstream;
    if (!base) {
      return new Response(`no upstream configured for "${target}"`, { status: 502 });
    }
    const upstreamUrl = `${base}${url.pathname}${url.search}`;
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // @ts-expect-error Bun supports duplex streaming bodies
      duplex: "half",
      redirect: "manual",
    };
    const res = await fetch(upstreamUrl, init);
    // Strip hop-by-hop / encoding headers that become invalid after fetch decodes
    // the body (double-decompression / length mismatch). Keep everything else,
    // notably content-type so SSE clients see "text/event-stream".
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("connection");
    // Stream body straight through (SSE-safe).
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

if (import.meta.main) {
  const tsUpstream = process.env.ARC_TS_UPSTREAM ?? "http://localhost:8787";
  const pyUpstream = process.env.ARC_PY_UPSTREAM;
  const port = Number(process.env.ARC_PROXY_PORT ?? 8080);
  const handler = makeProxy({ table: DEFAULT_TABLE, tsUpstream, pyUpstream });
  Bun.serve({ port, fetch: handler });
  console.log(`arclight proxy on :${port} → ts=${tsUpstream} py=${pyUpstream ?? "(unset)"}`);
}
