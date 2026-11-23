import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { acceptRequest, compileTool, eventRequest, safeField } from "./contract.mjs";

const labels = { hook: "Retell request", parse: "Read tool arguments", branch: "Valid request?", reply: "Reply to Retell" };
const format = value => JSON.stringify(value, null, 2) + "\n";
const edge = name => ({ node: name, type: "main", index: 0 });
const link = (...targets) => ({ main: targets.map(name => [edge(name)]) });

function uuid(seed) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), "8" + hex.slice(13, 16), "a" + hex.slice(17, 20), hex.slice(20, 32)].join("-");
}

async function readSource(root, file, extension) {
  if (typeof file !== "string" || path.isAbsolute(file) || path.extname(file) !== extension) {
    throw new Error("Use a relative " + extension + " file inside the blueprint directory.");
  }
  const candidate = await realpath(path.resolve(root, file));
  const rel = path.relative(root, candidate);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Workflow source leaves the blueprint directory.");
  return readFile(candidate, "utf8");
}

async function adapter(root, tool) {
  if (Boolean(tool.handler) === Boolean(tool.graph)) throw new Error("Choose one handler or graph for " + tool.name);
  if (tool.handler) {
    const jsCode = await readSource(root, tool.handler, ".js");
    return { entry: "Run tool", exit: "Run tool", connections: {}, nodes: [
      { name: "Run tool", type: "n8n-nodes-base.code", typeVersion: 2, position: [700, -80],
        parameters: { mode: "runOnceForEachItem", jsCode } },
    ] };
  }
  const graph = JSON.parse(await readSource(root, tool.graph, ".json"));
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || !graph.connections || Array.isArray(graph.connections) ||
      typeof graph.connections !== "object") throw new Error("A graph needs nodes and a connections object.");
  const names = new Set();
  for (const n of graph.nodes) {
    if (!n || typeof n.name !== "string" || !n.name.trim() || names.has(n.name) || Object.values(labels).includes(n.name) ||
        ["__proto__", "prototype", "constructor"].includes(n.name)) throw new Error("Invalid or duplicate graph node name.");
    if (typeof n.type !== "string" || /(?:webhook|respondToWebhook|Trigger)$/i.test(n.type) ||
        !Number.isFinite(n.typeVersion) || !n.parameters || typeof n.parameters !== "object") {
      throw new Error("Use action nodes with a type, typeVersion and parameters: " + n.name);
    }
    names.add(n.name);
  }
  if (!names.has(graph.entry) || !names.has(graph.exit)) throw new Error("Graph entry and exit must name existing nodes.");
  const forward = new Map([...names].map(name => [name, []]));
  for (const [source, ports] of Object.entries(graph.connections)) {
    if (!names.has(source) || !ports || typeof ports !== "object") throw new Error("Unknown connection source: " + source);
    for (const [port, groups] of Object.entries(ports)) {
      if (!Array.isArray(groups)) throw new Error("Invalid connection outputs on " + source);
      for (const group of groups) {
        if (!Array.isArray(group)) throw new Error("Invalid connection group on " + source);
        for (const target of group) {
          if (!target || !names.has(target.node) || typeof target.type !== "string" || !Number.isInteger(target.index) || target.index < 0) {
            throw new Error("Invalid connection target on " + source);
          }
          if (port === "main") forward.get(source).push(target.node);
        }
      }
    }
  }
  const reachable = (start, links) => {
    const visited = new Set([start]);
    for (const name of visited) for (const next of links.get(name)) visited.add(next);
    return visited;
  };
  const reverse = new Map([...names].map(name => [name, []]));
  for (const [name, targets] of forward) for (const target of targets) reverse.get(target).push(name);
  const toExit = reachable(graph.exit, reverse);
  if (forward.get(graph.exit).length || [...reachable(graph.entry, forward)].some(name => !toExit.has(name))) {
    throw new Error("Every connected main branch must reach the single terminal exit.");
  }
  return graph;
}

function makeWorkflow(slug, title, tool, graph, contextFields, credentialId) {
  const route = slug + "/" + tool.name;
  const make = (name, type, typeVersion, position, parameters) => ({
    name, type: "n8n-nodes-base." + type, typeVersion, position, parameters,
  });
  const hook = make(labels.hook, "webhook", 2.2, [0, 40], {
    httpMethod: "POST", path: route, authentication: "headerAuth", responseMode: "responseNode", options: {},
  });
  hook.webhookId = uuid(route + ":webhook");
  if (credentialId) hook.credentials = { httpHeaderAuth: { id: credentialId, name: "Easy Voice webhook" } };
  const input = tool.event ? "($json.body?.event ? (" + eventRequest.toString() + ")($json.body, " +
    JSON.stringify(tool.event) + ", " + JSON.stringify(Boolean(tool.includeSummary)) + ") : $json.body)" : "$json.body";
  const code = "const accept = " + acceptRequest.toString() + ";\nreturn { json: accept(" + input + ", " +
    JSON.stringify(tool) + ", " + JSON.stringify(contextFields) + ") };";
  const parse = make(labels.parse, "code", 2, [230, 40], { mode: "runOnceForEachItem", jsCode: code });
  const branch = make(labels.branch, "if", 2.3, [460, 40], {
    conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{ id: uuid(route + ":valid"), leftValue: "={{ $json.status }}", rightValue: "ready",
        operator: { type: "string", operation: "equals" } }], combinator: "and" }, options: {},
  });
  const reply = make(labels.reply, "respondToWebhook", 1.5, [1100, 70], {
    respondWith: "json", responseBody: "={{ $json }}", options: { responseCode: 200 },
  });
  const nodes = [hook, parse, branch, ...graph.nodes, reply].map((n, i) => ({
    ...n, id: uuid(route + ":" + n.name), position: n.position ?? [700 + i * 60, -80],
  }));
  const connections = { ...graph.connections, [labels.hook]: link(labels.parse), [labels.parse]: link(labels.branch),
    [labels.branch]: link(graph.entry, labels.reply),
    [graph.exit]: { ...graph.connections[graph.exit], ...link(labels.reply) } };
  return { name: title + " / " + tool.name, nodes, connections, settings: {
    executionOrder: "v1", saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveManualExecutions: false,
  } };
}

export async function compile(file, options = {}) {
  const root = await realpath(path.dirname(path.resolve(file)));
  const spec = JSON.parse(await readFile(file, "utf8"));
  if (typeof spec.slug !== "string" || spec.slug.length > 60 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(spec.slug)) throw new Error("Invalid stack slug.");
  for (const field of ["name", "greeting", "instructions"]) {
    if (typeof spec[field] !== "string" || !spec[field].trim()) throw new Error("Missing " + field);
  }
  const inputs = spec.tools ?? [];
  if (!Array.isArray(inputs) || (!inputs.length && !spec.afterCall)) throw new Error("Provide tools or an afterCall automation.");
  const contextFields = spec.contextFields ?? [];
  if (!Array.isArray(contextFields) || !contextFields.every(safeField)) throw new Error("Invalid contextFields.");
  const base = new URL(options.base ?? "https://example.invalid/tools");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Use an HTTPS webhook base without credentials, a query or a fragment.");
  const model = spec.model ?? "gpt-4.1-mini";
  const voice = options.voice ?? spec.voice ?? "SELECT_A_RETELL_VOICE";
  if (typeof model !== "string" || !model.trim() || typeof voice !== "string" || !voice.trim()) throw new Error("Invalid Retell model or voice.");
  const files = {};
  const tools = [];
  const routes = [];
  const names = new Set();
  for (const item of inputs) {
    const tool = compileTool(item);
    if (tool.name === "after_call") throw new Error("after_call is reserved for lifecycle events.");
    if (names.has(tool.name)) throw new Error("Duplicate tool: " + tool.name);
    names.add(tool.name);
    const graph = await adapter(root, item);
    const workflow = makeWorkflow(spec.slug, spec.name, tool, graph, contextFields, options.credential);
    const filename = "n8n-" + tool.name + ".json";
    const webhookPath = spec.slug + "/" + tool.name;
    const url = base.href.replace(/\/$/, "") + "/" + webhookPath;
    files[filename] = workflow;
    routes.push({ name: tool.name, workflow: filename, path: webhookPath, publicPath: new URL(url).pathname });
    tools.push({ type: "custom", name: tool.name, description: tool.description, parameters: tool.parameters,
      url, method: "POST", args_at_root: false, timeout_ms: 8000, max_retry: 0, speak_after_execution: true });
  }
  tools.push({ type: "end_call", name: "end_call", description: "End the call when the caller is finished." });
  const rules = "Use only tool results for operational facts. Ask for missing details. If a tool is unavailable, " +
    "say what remains unresolved and offer the configured human fallback. Announce a booking, message or transfer only " +
    "when a tool reports it completed. Ask for explicit confirmation before setting confirmed to true.";
  files["retell-llm.json"] = { model, begin_message: spec.greeting, general_prompt: spec.instructions + "\n\n" + rules, general_tools: tools };
  files["retell-agent.template.json"] = { agent_name: spec.name, voice_id: voice,
    response_engine: { type: "retell-llm", llm_id: "USE_CREATED_RETELL_LLM_ID" } };
  if (spec.language !== undefined) {
    const locales = Array.isArray(spec.language) ? spec.language : [spec.language];
    if (!locales.length || new Set(locales).size !== locales.length ||
        locales.some(locale => typeof locale !== "string" || !/^[a-z]{2,3}-(?:[A-Z]{2}|[0-9]{3})$/.test(locale))) {
      throw new Error("Use a Retell locale such as en-US or a list such as [en-US, fr-CA].");
    }
    files["retell-agent.template.json"].language = spec.language;
  }
  const manifest = { slug: spec.slug, name: spec.name, contextFields, tools: routes };
  if (spec.afterCall) {
    const event = spec.afterCall.event;
    if (!["call_ended", "call_analyzed"].includes(event)) throw new Error("afterCall.event must be call_ended or call_analyzed.");
    const includeSummary = spec.afterCall.includeSummary ?? false;
    if (typeof includeSummary !== "boolean" || (includeSummary && event !== "call_analyzed")) throw new Error("includeSummary requires a call_analyzed event.");
    const properties = { event: { type: "string", enum: [event] }, call_status: { type: "string" },
      disconnection_reason: { type: "string" }, duration_ms: { type: "number" }, call_successful: { type: "boolean" }, user_sentiment: { type: "string" } };
    if (includeSummary) properties.call_summary = { type: "string" };
    const tool = { ...compileTool({ name: "after_call", description: "Handle a call lifecycle event.", keyFields: ["event"],
      parameters: { type: "object", properties, required: ["event"] } }), event, includeSummary };
    const graph = await adapter(root, { ...spec.afterCall, name: "after_call" });
    const filename = "n8n-after_call.json";
    const route = spec.slug + "/after_call";
    const url = base.href.replace(/\/$/, "") + "/" + route;
    files[filename] = makeWorkflow(spec.slug, spec.name, tool, graph, contextFields, options.credential);
    Object.assign(files["retell-agent.template.json"], { webhook_url: url, webhook_events: [event] });
    manifest.afterCall = { name: "after_call", event, includeSummary, workflow: filename, path: route, publicPath: new URL(url).pathname };
  }
  files["manifest.json"] = manifest;
  return files;
}

export async function saveBundle(files, out) {
  const entries = Object.entries(files).map(([name, json]) => [name, format(json)]);
  const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
  const parent = path.resolve(out, files["manifest.json"].slug);
  await mkdir(parent, { recursive: true });
  const target = path.join(parent, hash);
  const temp = await mkdtemp(path.join(parent, ".building-"));
  try {
    for (const [name, data] of entries) await writeFile(path.join(temp, name), data, { flag: "wx" });
    try {
      await rename(temp, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
      const existing = (await readdir(target)).sort();
      if (JSON.stringify(existing) !== JSON.stringify(entries.map(([name]) => name).sort())) throw new Error("Existing bundle was changed: " + target);
      for (const [name, data] of entries) {
        if (await readFile(path.join(target, name), "utf8") !== data) throw new Error("Existing bundle was changed: " + target);
      }
    }
  } finally {
    // mkdtemp creates this private staging directory immediately inside parent.
    if (path.dirname(temp) === parent && path.basename(temp).startsWith(".building-")) await rm(temp, { recursive: true, force: true });
  }
  return target;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      out: { type: "string", default: "build" }, base: { type: "string" }, voice: { type: "string" }, credential: { type: "string" }, help: { type: "boolean" },
    } });
    if (values.help) console.log("node build.mjs STACK.json [--out DIR] [--base https://voice.example.org/tools] [--voice VOICE_ID] [--credential N8N_HEADER_CREDENTIAL_ID]");
    else {
      if (positionals.length !== 1) throw new Error("Provide one stack.json path. Use --help for options.");
      console.log(await saveBundle(await compile(positionals[0], values), values.out));
    }
  } catch (error) {
    console.error("Easy Voice: " + error.message);
    process.exitCode = 1;
  }
}
