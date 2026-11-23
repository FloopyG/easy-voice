import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eventRequest } from "./contract.mjs";

// Verify Retell's signature against the original bytes, before parsing or reshaping the envelope.
export function validSignature(bytes, header, key, now = Date.now()) {
  if (typeof header !== "string" || !key) return false;
  const parts = /^v=(\d+),d=([a-f0-9]{64})$/i.exec(header);
  if (!parts || !Number.isSafeInteger(Number(parts[1])) || Math.abs(now - Number(parts[1])) > 300_000) return false;
  const expected = createHmac("sha256", key).update(bytes).update(parts[1]).digest();
  return timingSafeEqual(expected, Buffer.from(parts[2], "hex"));
}

async function readBounded(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new RangeError("Body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function createBridge({ manifest, retellKey, agentId, upstreamBase, headerSecret }) {
  if (![retellKey, agentId, headerSecret, upstreamBase].every(x => typeof x === "string" && x.trim())) {
    throw new Error("Set RETELL_WEBHOOK_KEY, RETELL_AGENT_ID, N8N_WEBHOOK_BASE and EASY_VOICE_HEADER_SECRET.");
  }
  const base = new URL(upstreamBase);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("N8N_WEBHOOK_BASE needs HTTPS, or HTTP on loopback, without embedded credentials or a query.");
  }
  const endpoints = manifest.afterCall ? [...manifest.tools, manifest.afterCall] : manifest.tools;
  const routes = new Map(endpoints.map(tool => [tool.publicPath, tool]));
  return createServer({ requestTimeout: 10_000, headersTimeout: 8_000 }, async (req, res) => {
    const reply = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const route = routes.get(req.url);
    if (!route) return reply(404, { status: "unknown_tool" });
    if (req.method !== "POST") return reply(405, { status: "method_not_allowed" });
    let bytes;
    try { bytes = await readBounded(req, 1024 * 1024); } catch { return reply(413, { status: "invalid_body" }); }
    if (!validSignature(bytes, req.headers["x-retell-signature"], retellKey)) return reply(401, { status: "unauthorized" });
    let body;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { return reply(400, { status: "invalid_json" }); }
    if (route.event) body = eventRequest(body, route.event, route.includeSummary);
    if (body?.name !== route.name || body.call?.agent_id !== agentId || typeof body.call?.call_id !== "string" || !body.call.call_id.trim()) {
      return reply(403, { status: "wrong_call_or_tool" });
    }
    const metadata = Object.fromEntries((manifest.contextFields ?? [])
      .filter(name => Object.hasOwn(body.call.metadata ?? {}, name) && ["string", "number", "boolean"].includes(typeof body.call.metadata[name]))
      .map(name => [name, body.call.metadata[name]]));
    const call = { call_id: body.call.call_id, agent_id: agentId, metadata };
    try {
      // The operator's manifest selects every destination. Requests cannot supply an upstream URL.
      const response = await fetch(base.href.replace(/\/$/, "") + "/" + route.path, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(6000),
        headers: { "Content-Type": "application/json", "X-Easy-Voice-Token": headerSecret },
        body: JSON.stringify({ name: route.name, args: body.args, call }),
      });
      if (!response.ok || !response.body) {
        if (response.body) await response.body.cancel();
        return reply(502, { status: "tool_unavailable" });
      }
      const result = JSON.parse((await readBounded(response.body, 64 * 1024)).toString("utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result)) return reply(502, { status: "invalid_result" });
      return reply(200, result);
    } catch {
      return reply(502, { status: "tool_unavailable" });
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node bridge.mjs BUNDLE_DIRECTORY");
    const manifest = JSON.parse(await readFile(path.join(process.argv[2], "manifest.json"), "utf8"));
    const server = createBridge({ manifest, retellKey: process.env.RETELL_WEBHOOK_KEY,
      agentId: process.env.RETELL_AGENT_ID, upstreamBase: process.env.N8N_WEBHOOK_BASE, headerSecret: process.env.EASY_VOICE_HEADER_SECRET });
    const port = Number(process.env.EASY_VOICE_PORT ?? 8787);
    const host = process.env.EASY_VOICE_HOST ?? "127.0.0.1";
    server.listen(port, host, () => console.log("Easy Voice bridge listening on " + host + ":" + server.address().port));
  } catch (error) {
    console.error("Easy Voice: " + error.message);
    process.exitCode = 1;
  }
}
