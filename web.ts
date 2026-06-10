import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetRoutes } from "./server/routes/assets";

declare const Bun: {
  serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (...args: any[]) => any }): { stop(force?: boolean): void };
};

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ATTENTION_WEB_PORT ?? 4321);
const apiPort = Number(process.env.ATTENTION_API_PORT ?? 4333);
const clientDir = process.env.ATTENTION_CLIENT_DIR ?? path.join(root, "dist");
const app = new Hono();

app.all("/api/*", async (c) => {
  const target = new URL(c.req.url);
  target.protocol = "http:";
  target.host = `127.0.0.1:${apiPort}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.set("connection", "close");
  const response = await fetch(target, {
    method: c.req.method,
    headers,
    body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.arrayBuffer(),
    redirect: "manual",
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("connection", "close");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
});
app.route("/", assetRoutes(clientDir));

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  fetch: app.fetch,
});

console.log(`attention web listening on http://127.0.0.1:${port} (api http://127.0.0.1:${apiPort})`);

export function closeWebServer() {
  server.stop(true);
}
