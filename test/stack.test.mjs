import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile, saveBundle } from "../skills/easy-voice/scripts/build.mjs";
import { compileTool, acceptRequest, eventRequest } from "../skills/easy-voice/scripts/contract.mjs";
import { createBridge, validSignature } from "../skills/easy-voice/scripts/bridge.mjs";
import { example, replay } from "../demo.mjs";

const base = "https://voice.example.org/tools";
const desk = await compile(example("service-desk"), { base, voice: "demo-voice", credential: "fixture-id" });
const llm = desk["retell-llm.json"];
const manifest = desk["manifest.json"];
const run = (name, args, call = { call_id: "sample-call" }) =>
  replay(desk["n8n-" + name + ".json"], { name, args, call });
const sign = (body, key, time) => "v=" + time + ",d=" + createHmac("sha256", key).update(body).update(String(time)).digest("hex");

test("each Retell tool maps to an authenticated n8n workflow and the voice agent binds its engine separately", () => {
  for (const route of manifest.tools) {
    const tool = llm.general_tools.find(t => t.name === route.name);
    const hook = desk[route.workflow].nodes.find(n => n.type === "n8n-nodes-base.webhook");
    assert.equal(tool.url, base + "/" + hook.parameters.path);
    assert.equal(new URL(tool.url).pathname, route.publicPath);
    assert.equal(tool.args_at_root, false);
    assert.equal(tool.max_retry, 0);
    assert.equal(hook.parameters.authentication, "headerAuth");
    assert.equal(hook.credentials.httpHeaderAuth.id, "fixture-id");
    assert.equal(desk[route.workflow].active, undefined);
  }
  assert.equal(desk["retell-agent.template.json"].voice_id, "demo-voice");
  assert.equal(desk["retell-agent.template.json"].response_engine.llm_id, "USE_CREATED_RETELL_LLM_ID");
});

test("fixtures exercise the generated Code node, missing results and the human fallback", () => {
  assert.deepEqual(run("lookup_service", { service: " BRAKE CHECK " }), { status: "found", service: "Brake check", minutes: 30 });
  assert.deepEqual(run("lookup_service", { service: "boat repair" }), { status: "unknown_service" });
  for (const invalid of [{}, { service: null }, { service: " " }, { service: 8 }, { service: "x", admin: true }]) {
    assert.equal(run("lookup_service", invalid).status, "invalid_input");
  }
  const wrong = replay(desk["n8n-lookup_service.json"], { name: "bogus", args: { service: "brake check" } });
  assert.equal(wrong.status, "invalid_input");
});

test("confirmation gates the business graph and repeat attempts have the same action key", () => {
  const args = { reference: "JOB-105", reason: "billing", confirmed: false };
  assert.equal(run("prepare_callback", args).status, "needs_confirmation");
  const approved = { ...args, confirmed: true };
  const first = run("prepare_callback", approved);
  assert.equal(first.status, "draft");
  assert.equal(first.team, "accounts");
  assert.deepEqual(first, run("prepare_callback", approved));
  assert.notEqual(first.idempotency_key, run("prepare_callback", { ...approved, reference: "JOB-106" }).idempotency_key);
  assert.equal(run("prepare_callback", approved, {}).status, "invalid_input");
  assert.equal(run("prepare_callback", { ...approved, reason: "other" }).status, "invalid_input");
});

test("the same compiler runs an unrelated order-status blueprint", async () => {
  const order = await compile(example("order-desk"));
  assert.deepEqual(replay(order["n8n-lookup_order.json"], { name: "lookup_order", args: { reference: "j-104" } }), {
    status: "found", state: "ready for pickup",
  });
  assert.deepEqual(replay(order["n8n-lookup_order.json"], { name: "lookup_order", args: { reference: "J-999" } }), { status: "not_found" });
});

test("unsupported schemas and non-business idempotency fields are rejected", () => {
  const spec = { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } };
  assert.throws(() => compileTool({ ...spec, keyFields: ["absent"] }), /keyFields/);
  assert.throws(() => compileTool({ ...spec, parameters: { ...spec.parameters, properties: { x: { type: "string", pattern: ".+" } } } }), /Invalid field/);
  const normalized = acceptRequest({ name: "lookup", args: { x: "yes" }, call: { metadata: { tenant: "fixture", unwanted: "private" } } },
    compileTool(spec), ["tenant"]);
  assert.deepEqual(normalized.context, { tenant: "fixture" });
  assert.equal(normalized.call_id, null);
});

test("compilation is deterministic; parallel saves converge and locally edited output is preserved", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "easy-voice-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(desk, await compile(example("service-desk"), { base, voice: "demo-voice", credential: "fixture-id" }));
  const [a, b] = await Promise.all([saveBundle(desk, root), saveBundle(desk, root)]);
  assert.equal(a, b);
  const file = path.join(a, "retell-llm.json");
  await writeFile(file, "local edit");
  await assert.rejects(saveBundle(desk, root), /changed/);
  assert.equal(await readFile(file, "utf8"), "local edit");
});

test("a blueprint cannot import code from outside its directory", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "easy-voice-path-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = JSON.parse(await readFile(example("order-desk"), "utf8"));
  spec.tools[0].handler = path.resolve(root, "elsewhere.js");
  const file = path.join(root, "stack.json");
  await writeFile(file, JSON.stringify(spec));
  await assert.rejects(compile(file), /relative/);
  await assert.rejects(compile(example("order-desk"), { base: "https://someone:password@example.invalid/hooks" }), /without credentials/);
});

test("post-call events are provider webhooks, scoped to one event and repeatable by call ID", async () => {
  const agent = desk["retell-agent.template.json"];
  assert.deepEqual(agent.webhook_events, ["call_analyzed"]);
  assert.equal(new URL(agent.webhook_url).pathname, manifest.afterCall.publicPath);
  assert.equal(llm.general_tools.some(t => t.name === "after_call"), false);
  const workflow = desk[manifest.afterCall.workflow];
  const payload = { event: "call_analyzed", call: { call_id: "demo-call", transcript: "never return this",
    call_analysis: { call_successful: false, user_sentiment: "Negative", call_summary: "Requested a new time." } } };
  const result = replay(workflow, payload);
  assert.equal(result.status, "summary_draft");
  assert.equal(result.outcome, false);
  assert.equal(result.summary, "Requested a new time.");
  assert.equal(eventRequest(payload, "call_analyzed").args.call_summary, undefined);
  assert.deepEqual(result, replay(workflow, payload));
  assert.equal(JSON.stringify(result).includes("never return this"), false);
  assert.equal(replay(workflow, { ...payload, event: "call_started" }).status, "invalid_input");
  assert.equal(replay(workflow, { event: "call_analyzed", call: {} }).status, "invalid_input");
});

test("multilingual recognition and a post-call-only stack are independent of example tools", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "easy-voice-locales-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "stack.json");
  const stack = { slug: "visitor-desk", name: "Visitor Desk", language: ["en-US", "fr-CA"],
    greeting: "Hello, bonjour.", instructions: "Help visitors.", afterCall: { event: "call_ended", handler: "handle.js" } };
  await writeFile(path.join(root, "handle.js"), "return { json: { status: 'received', call_id: $json.call_id } };");
  await writeFile(file, JSON.stringify(stack));
  const files = await compile(file);
  assert.deepEqual(files["retell-agent.template.json"].language, ["en-US", "fr-CA"]);
  assert.deepEqual(files["retell-llm.json"].general_tools.map(t => t.name), ["end_call"]);
  assert.deepEqual(replay(files["n8n-after_call.json"], { event: "call_ended", call: { call_id: "demo" } }),
    { status: "received", call_id: "demo" });
  stack.language = "multi";
  await writeFile(file, JSON.stringify(stack));
  await assert.rejects(compile(file), /locale/);
});

test("a native action graph may use a real n8n connector and cannot send work down a dangling main branch", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "easy-voice-graph-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = JSON.parse(await readFile(example("order-desk"), "utf8"));
  const tool = spec.tools[0];
  delete tool.handler;
  tool.graph = "graph.json";
  await writeFile(path.join(root, "stack.json"), JSON.stringify(spec));
  const node = { name: "Check inventory", type: "n8n-nodes-base.httpRequest", typeVersion: 4.5,
    parameters: { method: "GET", url: "https://catalog.example.invalid/availability", options: { timeout: 2500 } } };
  const graph = { entry: node.name, exit: node.name, nodes: [node], connections: {} };
  await writeFile(path.join(root, "graph.json"), JSON.stringify(graph));
  const generated = (await compile(path.join(root, "stack.json")))["n8n-lookup_order.json"];
  assert.equal(generated.nodes.find(n => n.name === node.name).parameters.url, node.parameters.url);
  assert.equal(generated.connections["Valid request?"].main[0][0].node, node.name);
  assert.equal(generated.connections[node.name].main[0][0].node, "Reply to Retell");
  graph.connections[node.name] = { main: [[{ node: "missing", type: "main", index: 0 }]] };
  await writeFile(path.join(root, "graph.json"), JSON.stringify(graph));
  await assert.rejects(compile(path.join(root, "stack.json")), /Invalid connection target/);
});

test("signatures cover the original bytes and expire", () => {
  const time = 1660000000000, key = "test-key", bytes = Buffer.from('{ "value": "café" }');
  const header = sign(bytes, key, time);
  assert.equal(validSignature(bytes, header, key, time), true);
  assert.equal(validSignature(Buffer.from('{"value":"café"}'), header, key, time), false);
  assert.equal(validSignature(bytes, header, key, time + 300001), false);
  assert.equal(validSignature(bytes, "bad", key, time), false);
});

test("loopback bridge rejects bad callers and forwards only scoped inputs with a private n8n header", async t => {
  const seen = [];
  const target = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url, header: req.headers["x-easy-voice-token"], body: JSON.parse(raw) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(run("lookup_service", seen.at(-1).body.args)));
  });
  const listen = async s => { s.listen(0, "127.0.0.1"); await once(s, "listening"); return "http://127.0.0.1:" + s.address().port; };
  const close = s => new Promise(resolve => s.close(resolve));
  const local = await listen(target);
  t.after(() => close(target));
  const bridge = createBridge({ manifest: { ...manifest, contextFields: ["tenant"] }, retellKey: "test-key",
    agentId: "demo-agent", upstreamBase: local + "/webhook", headerSecret: "test-header" });
  const origin = await listen(bridge);
  t.after(() => close(bridge));
  const route = manifest.tools[0];
  const body = { name: route.name, args: { service: "brake check" }, call: { agent_id: "demo-agent", call_id: "demo-call",
    transcript: "not forwarded", metadata: { tenant: "sample", other: "not forwarded" } } };
  const send = (payload, signature, routePath = route.publicPath) => {
    const text = JSON.stringify(payload);
    return fetch(origin + routePath, { method: "POST", body: text, headers: {
      "x-retell-signature": signature ?? sign(text, "test-key", Date.now()),
    } });
  };
  assert.equal((await send(body, "invalid")).status, 401);
  assert.equal((await send({ ...body, call: { ...body.call, agent_id: "other-agent" } })).status, 403);
  assert.equal((await send(body, undefined, "/anything")).status, 404);
  assert.equal(seen.length, 0);
  const ok = await send(body);
  assert.deepEqual(await ok.json(), { status: "found", service: "Brake check", minutes: 30 });
  assert.deepEqual(seen[0], { path: "/webhook/" + route.path, header: "test-header",
    body: { name: route.name, args: body.args, call: { call_id: "demo-call", agent_id: "demo-agent", metadata: { tenant: "sample" } } } });
});
