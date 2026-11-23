# Easy Voice

**Retell + n8n AI builder for your coding agent.** Describe what a caller needs. Your coding agent uses the skill to build a Retell voice-agent draft, generate an n8n workflow for each tool and optionally process the outcome after the call. With both MCP servers connected, the agent can provision the drafts in a workspace you choose.

For example, a receptionist can look up a service, explain what it found, and prepare a callback for the right team. An order desk can check a reference and tell the caller when it cannot find a match. The same builder supports custom n8n graphs for your own CRM, scheduler or helpdesk.

## Install

Install the skill in the project where you want to build. The installer will offer compatible coding agents.

```sh
npx skills add FloopyG/easy-voice --skill easy-voice
```

Target a specific agent with `-a codex` or `-a claude-code`. The skills installer requires Node.js 22.20+ or 24+. You can also copy the complete [easy-voice skill folder](skills/easy-voice) into your agent’s skills directory. Its scripts and examples travel with it. Node.js 22+ runs the builder itself. [Agent Skills CLI](https://github.com/vercel-labs/skills).

In **Codex**, start with:

> Use $easy-voice to build an inbound service desk. Give it a tool to check a service and a second tool to prepare a callback after the caller confirms. Use made-up records, generate the Retell and n8n files, and test the unknown-service and declined-callback paths.

In **Claude Code**, invoke `/easy-voice` with the same brief. With another MCP-capable coding agent, load `SKILL.md` using its skills mechanism. The local build needs no provider credentials.

## Try it in a minute

```sh
git clone https://github.com/FloopyG/easy-voice.git
cd easy-voice
npm run demo
npm test
npm run build:demo
```

No npm install is needed for these commands. The demo replays the tool logic locally with fictional data. For a brake check it returns **30 minutes**. Unknown services return `unknown_service`. A declined callback returns `needs_confirmation`. A confirmed callback prepares a **draft** for review. A subsequent `call_analyzed` event prepares a CRM summary. The second blueprint returns a fictional order status. You can inspect the [service desk](skills/easy-voice/assets/service-desk/stack.json) and the [order desk](skills/easy-voice/assets/order-desk/stack.json).

## What gets built

```text
Caller → Retell agent → signed tool request → Easy Voice bridge
                                                    ↓
                                        authenticated n8n webhook
                                                    ↓
                                 validate arguments → business workflow
                                                    ↓
                                      JSON result → spoken response
```

The build command prints a revision directory containing `retell-llm.json`, `retell-agent.template.json`, one native `n8n-*.json` workflow per tool, and a route manifest. A repeated build of the same inputs reuses its revision. The Retell engine ID and voice are bound when the drafts are provisioned.

Change the brief and let your coding agent generate a blueprint, or [write one directly](skills/easy-voice/references/blueprint.md). Adapters can be short JavaScript handlers or native n8n graphs with their own branches, connectors and credential references. The offline replay covers the bundled examples. Live integrations run in n8n.

All four bundled workflows passed runtime-profile validation with n8n-mcp 2.94.2. The test suite also exercises a signed request through the bridge over loopback, covering invalid signatures, agent identity, private headers and metadata redaction.

## Connect real services

[Connect Retell MCP and n8n MCP](skills/easy-voice/references/mcp.md), then ask:

> Use $easy-voice to provision this blueprint as drafts in my staging workspace. Validate each n8n workflow, bind the Retell engine, read back the IDs and report what is ready to test.

Live use requires your vendor accounts, an HTTPS ingress and a configured n8n webhook credential. The optional bridge verifies signed requests before passing them to n8n. Phone calls, carrier charges and real CRM writes belong to the deployment you choose. The included examples make no outbound calls or business writes.

## Credits

- **Nazar Ohoniuk** created Easy Voice from his experience building Retell agents and n8n integrations. Built with assistance from OpenAI Codex.
- **Retell AI** provides the voice platform, hosted MCP server and signed custom-function protocol. [Retell MCP](https://www.retellai.com/blog/connect-retell-ai-mcp-server-to-ai-assistant) · [Custom functions](https://docs.retellai.com/build/single-multi-prompt/custom-function).
- **Romuald Czlonkowski and the n8n-mcp contributors** built the community MCP server used for workflow discovery, validation and provisioning. [n8n-mcp](https://github.com/czlonkowski/n8n-mcp).
- **The n8n team and contributors** maintain the workflow engine and node implementations. **Vercel Labs and contributors** maintain the optional skills installer. [n8n](https://github.com/n8n-io/n8n) · [Agent Skills CLI](https://github.com/vercel-labs/skills).

Easy Voice’s original code and skill are distributed under the [MIT License](LICENSE). Each upstream project or hosted service retains its own terms.
