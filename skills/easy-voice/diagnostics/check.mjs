import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { providers, failureState, probeAccount } from "./probes.mjs";

const n8nVersion = "n8n-mcp@2.94.2";
const n8nLauncher = process.platform === "win32"
  ? { command: "cmd.exe", args: ["/d", "/c", "npx", "-y", n8nVersion] }
  : { command: "npx", args: ["-y", n8nVersion] };
const n8nSettings = { MCP_MODE: "stdio", LOG_LEVEL: "error", DISABLE_CONSOLE_OUTPUT: "true", N8N_MCP_TELEMETRY_DISABLED: "true" };
const retellUrl = "https://mcp.retellai.com";
const accountUrls = { retell: "https://dashboard.retellai.com/", n8n: "https://docs.n8n.io/api/authentication/" };
const installCommand = "npm install --prefix skills/easy-voice/diagnostics --ignore-scripts --no-audit --no-fund";
const states = {
  connected: "Account read succeeded.",
  credentials: "Connect or update your account credentials.",
  setup: "Configure the MCP server and your instance settings.",
  "docs-only": "The n8n MCP is in documentation-only mode. Connect your instance and API key.",
  unsupported: "The configured MCP server does not expose the required tools.",
  permission: "The provider denied this read. Check permissions for the intended workspace.",
  "network-policy": "The n8n MCP blocked the instance address. Use an address allowed by your server's network policy.",
  approval: "The MCP client needs permission to run the account check.",
  unavailable: "The service or network is temporarily unavailable. Retry the check.",
  dependency: "Install the optional terminal probe dependency, then retry: " + installCommand,
  unverified: "The response could not confirm access. Check the MCP server and retry.",
  address: "Use an HTTPS n8n instance URL, or HTTP on localhost, without credentials, a query or a fragment.",
};
const usage = "Usage: node check.mjs [--only retell|n8n] [--json | --setup codex|claude-code]\nWith no flags, check both accounts from this shell. Setup prints configuration using environment references.";
const needsSetup = state => ["credentials", "setup", "docs-only", "unsupported", "address"].includes(state);

export function setupSnippet(host, selected) {
  if (host === "codex") {
    const sections = [];
    if (selected.includes("retell")) sections.push('[mcp_servers.retell]\nurl = "' + retellUrl + '"\nbearer_token_env_var = "RETELL_API_KEY"');
    if (selected.includes("n8n")) sections.push([
      "[mcp_servers.n8n_local]",
      "command = " + JSON.stringify(n8nLauncher.command), "args = " + JSON.stringify(n8nLauncher.args),
      'env_vars = ["N8N_API_URL", "N8N_API_KEY"]', "", "[mcp_servers.n8n_local.env]",
      ...Object.entries(n8nSettings).map(([key, value]) => key + " = " + JSON.stringify(value)),
    ].join("\n"));
    return sections.join("\n\n");
  }
  const ref = name => "$" + "{" + name + "}";
  const mcpServers = {};
  if (selected.includes("retell")) mcpServers.retell = { type: "http", url: retellUrl, headers: { Authorization: "Bearer " + ref("RETELL_API_KEY") } };
  if (selected.includes("n8n")) mcpServers.n8n_local = {
    type: "stdio", ...n8nLauncher, env: { ...n8nSettings, N8N_API_URL: ref("N8N_API_URL"), N8N_API_KEY: ref("N8N_API_KEY") },
  };
  return JSON.stringify({ mcpServers }, null, 2);
}

function validInstance(value) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (local && url.protocol === "http:")) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

// Shell diagnostics use only explicitly supplied environment variables. The skill uses the host's own MCPs.
export async function checkFromShell(provider, env = process.env) {
  const required = provider === "retell" ? ["RETELL_API_KEY"] : ["N8N_API_URL", "N8N_API_KEY"];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) return { state: "credentials", missing };
  if (provider === "n8n" && !validInstance(env.N8N_API_URL)) return { state: "address" };
  // The first n8n launch can also download the pinned MCP server through npx.
  const startupTimeout = provider === "n8n" ? 120000 : 30000;
  let client;
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    client = new Client({ name: "easy-voice-connection-check", version: "0.2.0" });
    let transport;
    if (provider === "retell") {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(new URL(retellUrl), {
        requestInit: { headers: { Authorization: "Bearer " + env.RETELL_API_KEY }, redirect: "error" },
      });
    } else {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({
        ...n8nLauncher, stderr: "ignore", env: { ...n8nSettings, N8N_API_URL: env.N8N_API_URL, N8N_API_KEY: env.N8N_API_KEY },
      });
    }
    await client.connect(transport, { signal: AbortSignal.timeout(startupTimeout), timeout: startupTimeout });
    return { state: await probeAccount(provider, client) };
  } catch (error) {
    return { state: error.code === "ERR_MODULE_NOT_FOUND" ? "dependency" : failureState(error) };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function main() {
  let flags;
  try {
    ({ values: flags } = parseArgs({ options: { only: { type: "string" }, setup: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } } }));
  } catch { console.error(usage); return 2; }
  if (flags.help) { console.log(usage); return 0; }
  if ((flags.only !== undefined && !providers.includes(flags.only)) ||
      (flags.setup !== undefined && !["codex", "claude-code"].includes(flags.setup)) || (flags.setup && flags.json)) {
    console.error(usage); return 2;
  }
  const selected = flags.only ? [flags.only] : providers;
  if (flags.setup) { console.log(setupSnippet(flags.setup, selected)); return 0; }
  const results = Object.fromEntries(await Promise.all(selected.map(async provider => [provider, await checkFromShell(provider)])));
  if (flags.json) console.log(JSON.stringify({ context: "shell", providers: results }));
  else {
    console.log("Checking the MCP connections available to this shell.");
    for (const [provider, result] of Object.entries(results)) {
      console.log(provider + " — " + states[result.state]);
      if (result.missing) console.log("  Set privately: " + result.missing.join(", "));
      if (needsSetup(result.state)) console.log("  Account setup: " + accountUrls[provider]);
    }
    const pending = selected.filter(provider => needsSetup(results[provider].state));
    if (pending.length && process.stdin.isTTY && process.stdout.isTTY) {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const host = (await input.question("Show setup for " + pending.join(" and ") + "? Enter codex, claude-code, or press Enter to skip: ")).trim();
        if (["codex", "claude-code"].includes(host)) console.log(setupSnippet(host, pending));
      } finally { input.close(); }
    }
  }
  return selected.every(provider => results[provider].state === "connected") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
