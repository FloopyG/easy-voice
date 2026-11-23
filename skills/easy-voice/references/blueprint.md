# Blueprint contract

Create `stack.json` in the user's project. Paths to adapters are relative to that file and must stay within its directory.

| Field | Meaning |
| --- | --- |
| `slug` | Stable lowercase letters, digits and hyphens. Used in every webhook path. |
| `name`, `greeting`, `instructions` | Display name, first spoken line, and the agent's job and fallback behavior. |
| `tools` | Named call-time capabilities. An empty list is valid with an after-call automation. |
| `afterCall` | Optional lifecycle automation. Supply `event` (`call_analyzed` or `call_ended`) and a handler or graph. |
| `voice`, `model` | Optional Retell voice ID and response-engine model. The default model is `gpt-4.1-mini`. An omitted voice leaves an explicit binding to fill during provisioning. |
| `language` | Optional Retell locale for speech recognition, e.g. `"en-US"`. Pass an array such as `["en-US", "fr-CA"]` for multilingual recognition, describe the spoken languages in the instructions, and pick a compatible voice. Verify supported locales in the current Retell create-agent schema. |
| `contextFields` | Optional allowlist of scalar `call.metadata` keys that an adapter may read. |

Each tool needs `name`, `description`, `parameters` and exactly one of `handler` or `graph`. Parameters use a JSON Schema object with named scalar properties (string, boolean, number or integer), descriptions, optional enums and a required list. Extra arguments are rejected. Build provider-specific nested payloads inside the adapter.

```json
{
  "name": "get_inventory",
  "description": "Check stock for the requested item.",
  "parameters": {
    "type": "object",
    "properties": { "sku": { "type": "string", "description": "Item code supplied by the caller" } },
    "required": ["sku"]
  },
  "handler": "inventory.js"
}
```

A handler is the body of an n8n Code node running once per item. It reads `$json.args`, `$json.context` and `$json.call_id`. Return `{ json: { status: "...", ... } }` with only the information the agent should use in its next turn.

For a real integration, use `graph` to point to a JSON file with standard n8n `nodes` and `connections`, plus `entry` and `exit` naming two nodes (or the same node). Easy Voice adds the authenticated Webhook, input check, invalid-request branch and final Respond to Webhook node. All ordinary branches must reach the designated exit and return one response item. Set connector timeouts below the voice tool's eight-second budget. For slow jobs, enqueue durably and return a truthful pending status. A complete [two-node graph](../assets/service-desk/callback-graph.json) is included.

For an action that requires a read-back, set `"confirm": true`. The builder adds a required boolean `confirmed`; a false value returns `needs_confirmation` before any business node runs. This expresses conversational consent. Enforce identity, authorization and business limits in the destination.

Set `keyFields` to the required fields identifying one logical operation, for example `["appointment_id", "slot"]`. The adapter receives `$json.idempotency_key`, derived from the call ID, tool and those values. Use it for an atomic upsert or the downstream API's idempotency mechanism before a real write. A separate call has a new call ID; use a business-level key as well when uniqueness must span calls. The generated Retell tools have retries off by default.

## After a call

Choose `call_analyzed` to use post-call analysis or `call_ended` to act when the conversation ends. The builder sets the agent’s `webhook_url` and `webhook_events` and generates `n8n-after_call.json`. The adapter receives the event name and the available call status, disconnection reason, duration, success flag and sentiment in `$json.args`. Set `afterCall.includeSummary` to `true` to include the available `call_summary` for a staff or CRM handoff. Its default is false. The call ID, allowlisted context and an idempotency key are separate. A timeout or redelivery must resolve to the same destination record. Define additional business fields explicitly if extending this projection. [Retell lifecycle events](https://docs.retellai.com/features/webhook-overview).

## Output

```text
build/<slug>/<revision>/
  manifest.json               tool names, webhook routes and workflow files
  retell-llm.json             response engine and custom tool contracts
  retell-agent.template.json  agent settings; bind returned LLM and voice IDs
  n8n-<tool>.json             native importable workflow, one per tool
```

`--base https://voice.your-domain.com/tools` sets the public HTTPS prefix. The example.invalid default keeps offline drafts inert. `--voice VOICE_ID` selects a Retell voice. `--credential ID` attaches an existing n8n Header Auth credential reference named **Easy Voice webhook**. Without one, the workflow still requires Header Auth and needs the credential selected before activation.

The same input produces the same revision. Edited or unexpected contents in a revision are preserved and cause a clear error. Make changes in the blueprint, or choose another output directory.
