---
name: easy-voice
description: Build or revise a Retell voice agent and its n8n tool workflows from a plain-language brief. Use for receptionists, customer support, booking, intake, CRM lookups, and other voice automations. Produces local artifacts and can provision drafts through connected Retell and n8n MCP servers.
---

# Easy Voice

Turn the user's job for a caller into a reusable stack. Use this skill's directory as the base for its scripts and examples. Write the user's blueprint and outputs into their project.

## Build from the brief

1. Identify what the caller can ask, what the business system can actually do, and what the agent may promise. For an unspecified dependency, use a fictional fixture with an explicit result such as `draft` or `not_found`. Ask only when a missing decision changes the requested outcome or a real destination.
2. Design one named Retell tool per action needed during a conversation. Use `afterCall` for work that should happen automatically when a call ends or its analysis arrives. Keep model-visible arguments small. Select customer or tenant identity from trusted call context and apply the business system's authorization before returning private records. For a consequential action, define its confirmation step, stable business key and downstream duplicate handling.
3. Write a `stack.json` and an adapter for each tool. A short `.js` handler covers a lookup or transformation. A native n8n graph can call a CRM, branch, retry or use credentials already stored in n8n. See [the blueprint contract](references/blueprint.md). The [service desk](assets/service-desk/stack.json) and [order desk](assets/order-desk/stack.json) show different combinations.
4. Run `node <skill-dir>/scripts/build.mjs <project>/stack.json --out <project>/build`. Test at least the caller's happy path and the relevant failure or refusal paths. For a remote integration, use the connected n8n MCP's node docs and validator; reserve networked connector tests for a staging target. Return the bundle path, tool names and what you actually verified.
5. When the request includes creating resources in a named workspace, follow [MCP provisioning](references/mcp.md). Use the connected MCPs to create or update the workflows and bind the Retell engine and voice agent. A request for a local build ends with the artifacts. Publishing, attaching a phone number, dialing or sending a message requires the corresponding user intent.

## Updating existing stacks

Read the existing blueprint and the actual tool schemas first. Preserve tool names, webhook paths and provider IDs that deployed integrations already use. Regenerate into a new content-addressed bundle. Reconcile any remote change against the saved IDs and current draft version before retrying. Report unresolved credentials or staging checks explicitly.
