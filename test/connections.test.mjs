import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeAccount, failureState } from "../skills/easy-voice/diagnostics/probes.mjs";
import { checkFromShell, setupSnippet } from "../skills/easy-voice/diagnostics/check.mjs";

const path = "/get-concurrency";
const endpoint = "getConcurrency";
const retellTools = ["list_api_endpoints", "get_api_endpoint_schema", "invoke_api_endpoint"];
const n8nTools = ["n8n_list_workflows"];
const textResult = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function mockClient(names, responses) {
  const calls = [];
  return {
    calls,
    async listTools() { return { tools: names.map(name => ({ name })) }; },
    async callTool(request) {
      calls.push(request);
      assert.ok(Object.hasOwn(responses, request.name), "Unexpected MCP call");
      return responses[request.name];
    },
  };
}

function retell(overrides = {}) {
  return mockClient(retellTools, {
    list_api_endpoints: textResult({ endpoints: [{ endpoint, method: "GET", path }] }),
    get_api_endpoint_schema: textResult({ endpoint, method: "GET", path, input_schema: { type: "object", properties: {} } }),
    invoke_api_endpoint: textResult({ current_concurrency: 0, concurrency_limit: 0 }),
    ...overrides,
  });
}

test("Retell verifies the discovered schema and uses only the account-level GET; zero counts pass", async () => {
  const client = retell();
  assert.equal(await probeAccount("retell", client), "connected");
  assert.deepEqual(client.calls, [
    { name: retellTools[0], arguments: { search: path } },
    { name: retellTools[1], arguments: { endpoint } },
    { name: retellTools[2], arguments: { endpoint, arguments: {} } },
  ]);
});

test("Retell discovery cannot pass as account authentication; status does not expose error bodies", async () => {
  const client = retell({ invoke_api_endpoint: { isError: true, content: [{ type: "text", text: "API Error: Status 401 (Unauthorized). Response: private test detail" }] } });
  assert.equal(await probeAccount("retell", client), "credentials");
  const malformed = retell({ invoke_api_endpoint: textResult({ success: true }) });
  assert.equal(await probeAccount("retell", malformed), "unverified");
});

test("a changed Retell schema or ambiguous endpoint stops before the API invocation", async () => {
  const changed = retell({ get_api_endpoint_schema: textResult({ endpoint, method: "POST", path }) });
  assert.equal(await probeAccount("retell", changed), "unverified");
  assert.equal(changed.calls.length, 2);
  const match = { endpoint, path, method: "GET" };
  const ambiguous = retell({ list_api_endpoints: textResult({ endpoints: [match, match] }) });
  assert.equal(await probeAccount("retell", ambiguous), "unverified");
  assert.equal(ambiguous.calls.length, 1);
});

test("n8n reads at most one unpinned-payload workflow and permits empty accounts", async () => {
  for (const workflows of [[], [{ name: "private fixture" }]]) {
    const client = mockClient(n8nTools, { n8n_list_workflows: { structuredContent: { success: true, data: { workflows } } } });
    assert.equal(await probeAccount("n8n", client), "connected");
    assert.deepEqual(client.calls, [{ name: "n8n_list_workflows", arguments: { limit: 1, excludePinnedData: true } }]);
  }
});

test("n8n discovery, transport success, and malformed payloads cannot give a false green", async () => {
  assert.equal(await probeAccount("n8n", null), "setup");
  assert.equal(await probeAccount("n8n", mockClient(["validate_workflow"], {})), "docs-only");
  assert.equal(await probeAccount("n8n", mockClient(["some_other_tool"], {})), "unsupported");
  for (const [reply, expected] of [
    [{ success: false, code: "AUTHENTICATION_ERROR", error: "check key" }, "credentials"],
    [{ success: false, error: "403 Forbidden" }, "permission"],
    [{ success: false, error: "429 Too Many Requests" }, "unavailable"],
    [{ success: false, code: "NO_RESPONSE", error: "Unable to connect to n8n" }, "unavailable"],
    [{ success: false, error: "SSRF protection: Localhost access is blocked in strict mode" }, "network-policy"],
    [{ success: true, data: {} }, "unverified"],
  ]) {
    assert.equal(await probeAccount("n8n", mockClient(n8nTools, { n8n_list_workflows: textResult(reply) })), expected);
  }
});

test("tool pagination, a looping cursor and a host refusal are handled", async () => {
  const client = retell();
  client.listTools = async ({ cursor }) => cursor
    ? { tools: retellTools.map(name => ({ name })) }
    : { tools: [], nextCursor: "next" };
  assert.equal(await probeAccount("retell", client), "connected");
  client.listTools = async () => ({ tools: [], nextCursor: "same" });
  assert.equal(await probeAccount("retell", client), "unverified");
  client.listTools = async () => { throw new Error("User denied tool call"); };
  assert.equal(await probeAccount("retell", client), "approval");
  assert.equal(failureState(new Error("fetch failed")), "unavailable");
});

test("shell credentials are independent and plain HTTP is limited to local development", async () => {
  const env = { N8N_API_URL: "http://example.invalid", N8N_API_KEY: "dummy-value" };
  assert.deepEqual(await checkFromShell("retell", env), { state: "credentials", missing: ["RETELL_API_KEY"] });
  assert.deepEqual(await checkFromShell("n8n", env), { state: "address" });
  for (const url of ["https://name:dummy@example.invalid", "https://example.invalid/?key=dummy", "not-a-url"]) {
    assert.deepEqual(await checkFromShell("n8n", { ...env, N8N_API_URL: url }), { state: "address" });
  }
});

test("onboarding emits only selected registrations and uses environment references", () => {
  const codex = setupSnippet("codex", ["n8n"]);
  assert.match(codex, /\[mcp_servers\.n8n_local\]/);
  assert.doesNotMatch(codex, /retell/i);
  const claude = JSON.parse(setupSnippet("claude-code", ["retell"])).mcpServers;
  assert.deepEqual(Object.keys(claude), ["retell"]);
  assert.equal(claude.retell.headers.Authorization, "Bearer $" + "{RETELL_API_KEY}");
  assert.equal(JSON.parse(setupSnippet("claude-code", ["n8n"])).mcpServers.n8n_local.env.N8N_API_KEY, "$" + "{N8N_API_KEY}");
});

const cli = fileURLToPath(new URL("../skills/easy-voice/diagnostics/check.mjs", import.meta.url));
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, RETELL_API_KEY: "", N8N_API_URL: "", N8N_API_KEY: "", ...env },
  });
}
test("CLI reports both missing accounts, supports selective retries and non-interactive setup", () => {
  const result = run(["--json"]);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { context: "shell", providers: {
    retell: { state: "credentials", missing: ["RETELL_API_KEY"] },
    n8n: { state: "credentials", missing: ["N8N_API_URL", "N8N_API_KEY"] },
  } });
  assert.deepEqual(Object.keys(JSON.parse(run(["--only", "retell", "--json"]).stdout).providers), ["retell"]);
  const setup = run(["--setup", "claude-code", "--only", "retell"], { RETELL_API_KEY: "dummy-never-echo" });
  assert.equal(setup.status, 0);
  assert.doesNotMatch(setup.stdout, /dummy-never-echo/);
  assert.deepEqual(Object.keys(JSON.parse(setup.stdout).mcpServers), ["retell"]);
  const plain = run([]);
  assert.match(plain.stdout, /dashboard\.retellai\.com/);
  assert.match(plain.stdout, /docs\.n8n\.io/);
  assert.equal(run(["--only", "something-else"]).status, 2);
});
