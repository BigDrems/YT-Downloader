import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (c) => {
  return c.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3001);

serve(
  {
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  },
  (info) => {
    console.log(`YT Clipper server listening on http://${info.address}:${info.port}`);
  },
);
