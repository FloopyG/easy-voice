# Connecting and provisioning

The skill runs locally without accounts. Draft provisioning uses a Retell workspace and an n8n instance with management API access. The tested community server is Romuald Czlonkowski’s `n8n-mcp` 2.94.2. It is separate from n8n's built-in MCP server and exposes different tool names.

## What to check

Use the coding agent's selected MCP connections, regardless of their aliases. These probes are read-only. A working server can advertise tools before an account is connected.

| Provider | Authenticated read | Evidence of success |
| --- | --- | --- |
| Retell | Call `list_api_endpoints` with `{"search":"/get-concurrency"}`. Find the exact `GET /get-concurrency` entry and read its `get_api_endpoint_schema`. Verify the method, path and absence of required inputs. Call `invoke_api_endpoint` with the discovered `endpoint` and `arguments: {}`. | A successful account response containing numeric `current_concurrency` and `concurrency_limit`, including zero. [Endpoint reference](https://docs.retellai.com/api-references/get-concurrency). |
| n8n | Call `n8n_list_workflows` with `{"limit":1,"excludePinnedData":true}`. | `success: true` and a `data.workflows` array. An empty list succeeds. A server offering only documentation or validation needs an instance URL and management API key. |

Inspect both the MCP error flag and tool payload. A `401` indicates missing or rejected credentials. A `403` requires checking workspace permissions. A host tool-approval denial is a separate permission request. If n8n MCP blocks the instance address, ask for an address allowed by its network policy. For a timeout, rate limit or outage, offer a retry. For an unfamiliar server or response, report “couldn't verify” and identify the required tool. Avoid printing workflow records, quota values, keys or raw error bodies in the conversation. A successful read verifies account access. Writes can require additional permissions.

## Connect the missing account

- **Retell:** open the user's [Retell dashboard](https://dashboard.retellai.com/), choose the intended workspace and have them set `RETELL_API_KEY` privately for the client. Register the hosted MCP with bearer authentication if missing.
- **n8n:** use the intended instance URL and create or choose an API key under **Settings → n8n API** that permits listing workflows. Have the user set `N8N_API_URL` and `N8N_API_KEY` privately in the client environment. Reuse the community server if already installed in docs-only mode. [n8n API authentication](https://docs.n8n.io/api/authentication/).
- Prefer the host's MCP settings when available. For Codex or Claude Code, `node <skill-dir>/diagnostics/check.mjs --setup codex --only n8n` prints a credential-free example. Use `claude-code` or `--only retell` as appropriate. After the user opts in, add **only** the missing settings to the scope they choose, preserving aliases, other servers and existing credentials. Have them set keys outside chat and the repository, refresh/restart their coding agent if necessary, then rerun the failed reads in that client.

Configure a streamable HTTP server named `retell` at `https://mcp.retellai.com`. Supply your Retell API key through your client's bearer-token setting. Configure `n8n_local` (or your preferred alias) as a stdio server running `npx -y n8n-mcp@2.94.2` with `MCP_MODE=stdio`, `LOG_LEVEL=error`, `DISABLE_CONSOLE_OUTPUT=true`, and your own `N8N_API_URL` and `N8N_API_KEY`. Reuse existing connections when present.

**Codex example** for a private project `.codex/config.toml`. Set the three credential/URL variables in the environment of the process that starts Codex. Restart the session and use `/mcp` to check the tools.

```toml
[mcp_servers.retell]
url = "https://mcp.retellai.com"
bearer_token_env_var = "RETELL_API_KEY"

[mcp_servers.n8n_local]
command = "npx"
args = ["-y", "n8n-mcp@2.94.2"]
env_vars = ["N8N_API_URL", "N8N_API_KEY"]

[mcp_servers.n8n_local.env]
MCP_MODE = "stdio"
LOG_LEVEL = "error"
DISABLE_CONSOLE_OUTPUT = "true"
N8N_MCP_TELEMETRY_DISABLED = "true"
```

On Windows, when the client cannot launch `npx` directly, use `command = "cmd.exe"` and `args = ["/d", "/c", "npx", "-y", "n8n-mcp@2.94.2"]`. Claude Code and other MCP-capable agents can register the same HTTP and stdio transports in their own private settings. Keep API keys in local secrets or a credential manager. [Retell MCP setup](https://www.retellai.com/blog/connect-retell-ai-mcp-server-to-ai-assistant) · [n8n-mcp setup](https://github.com/czlonkowski/n8n-mcp) · [Codex MCP settings](https://developers.openai.com/codex/mcp/).

## Build the drafts through MCP

1. Use the verified connections for the target workspace. On n8n use `get_node` and `validate_workflow` for the actual node versions. On Retell discover the available endpoints and read each live input schema before invoking it.
2. Pick a voice from the target Retell account. Compile using the staging HTTPS prefix and the n8n Header Auth credential ID if available. Open the generated manifest. Avoid sending .invalid URLs or unresolved ID markers to a provider. If infrastructure is missing, build what can be completed locally and state the exact binding still needed.
3. For each generated n8n file, call `validate_workflow` with its object. Create the workflow with `n8n_create_workflow` in the requested staging project or use its saved ID to update the intended draft. Creation takes `name`, `nodes`, `connections` and `settings`. Read back through `n8n_get_workflow` and confirm the path and inactive state. A live existing workflow needs a separate draft or staging copy.
4. Through Retell MCP create the response engine (`POST /create-retell-llm`) with `retell-llm.json`. Substitute the returned `llm_id` and the selected voice into `retell-agent.template.json`. Create the voice agent (`POST /create-agent`). Read back the agent, engine association, draft version, custom tool URLs and any requested lifecycle webhook. Provision the manifest’s optional `afterCall.workflow` alongside the call-time workflows. Use the provider's draft-update endpoints for an existing binding.
5. Keep a private receipt at `.easy-voice/<slug>.json` with the workspace, local revision, n8n workflow IDs, Retell engine ID, agent ID and version. Record each acknowledged create before moving on. If a call times out after a possible create, list/read first and reconcile by target, workflow name, paths and tool contracts. If a match is ambiguous, stop before creating another resource. Keep published versions, phone numbers and credentials out of automatic rewrites.

## Signed delivery to n8n

The included bridge accepts only the tool routes in one generated manifest. Point the Retell tool URLs at its public HTTPS prefix and run it behind your HTTPS reverse proxy. It verifies Retell's timestamped HMAC over the original body, checks the configured agent ID, drops the transcript and undeclared metadata, then forwards to the matching n8n webhook using a separate private header. Retell requires the API key marked with the **webhook badge** for signature verification. [Retell signature verification](https://docs.retellai.com/features/secure-webhook).

| Bridge process variable | Value |
| --- | --- |
| `RETELL_WEBHOOK_KEY` | Webhook-badged Retell key. May differ from the MCP management key. |
| `RETELL_AGENT_ID` | Agent ID returned by Retell for this stack. |
| `N8N_WEBHOOK_BASE` | n8n webhook prefix, e.g. `http://127.0.0.1:5678/webhook` behind the same host, or your private HTTPS endpoint. |
| `EASY_VOICE_HEADER_SECRET` | Random shared secret also stored in an n8n Header Auth credential with header name `X-Easy-Voice-Token`. Select that credential on every generated webhook. |
| `EASY_VOICE_HOST`, `EASY_VOICE_PORT` | Optional. Defaults are loopback and port 8787. |

```sh
node <skill-dir>/scripts/bridge.mjs <bundle-directory>
```

The reverse proxy must preserve the paths in `manifest.json` and the original request body. For a staging test use n8n's `/webhook-test` prefix while its test listener is open, or a dedicated staging workflow explicitly published for integration tests. n8n's production `/webhook` path becomes available when the workflow is active. Confirm the whole path with fictional data before connecting a real destination. An existing gateway can replace this bridge if it enforces the same signature, agent and upstream-auth boundaries. [n8n webhook URLs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).

A tool response of `draft` means prepared only; a callback, notification or booking is complete only after the destination acknowledges it. For a native live connector, validate the error and replay paths with staging credentials, including the case where a downstream write succeeds but its response is lost.
