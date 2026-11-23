import { Script } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { compile } from "./skills/easy-voice/scripts/build.mjs";

export const example = name => fileURLToPath(new URL("./skills/easy-voice/assets/" + name + "/stack.json", import.meta.url));

// Fixture replay runs trusted local Code nodes and the compiler's validation branch.
// Provider integrations, arbitrary native n8n nodes and real calls belong in a staging instance.
export function replay(workflow, envelope) {
  const nodes = new Map(workflow.nodes.map(n => [n.name, n]));
  const hook = workflow.nodes.find(n => n.type === "n8n-nodes-base.webhook");
  let next = workflow.connections[hook.name].main[0][0].node;
  let item = { body: envelope };
  for (let step = 0; step < 50; step++) {
    const node = nodes.get(next);
    let output = 0;
    if (node.type === "n8n-nodes-base.respondToWebhook") return item;
    if (node.type === "n8n-nodes-base.code") {
      const script = new Script("(function () {\n" + node.parameters.jsCode + "\n})()", { filename: next + ".js" });
      item = JSON.parse(JSON.stringify(script.runInNewContext({ $json: item }, { timeout: 500 }).json));
    } else if (node.type === "n8n-nodes-base.if" && node.name === "Valid request?") {
      output = item.status === "ready" ? 0 : 1;
    } else {
      throw new Error("Use n8n to execute node " + next + " (" + node.type + ").");
    }
    const targets = workflow.connections[next]?.main?.[output];
    if (targets?.length !== 1) throw new Error("Use n8n to execute branching or parallel business nodes.");
    next = targets[0].node;
  }
  throw new Error("Fixture exceeded its replay step limit.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const files = await compile(example("service-desk"));
  const cases = [
    ["Known service", "lookup_service", { service: "brake check" }],
    ["Unknown service", "lookup_service", { service: "boat repair" }],
    ["Caller has not confirmed", "prepare_callback", { reference: "DEMO-104", reason: "billing", confirmed: false }],
    ["Caller confirms", "prepare_callback", { reference: "DEMO-104", reason: "billing", confirmed: true }],
  ];
  console.log("Harbor Service Desk | offline fixture replay\n");
  for (const [label, name, args] of cases) {
    const result = replay(files["n8n-" + name + ".json"], { name, args, call: { call_id: "demo-call" } });
    console.log(label + " -> " + JSON.stringify(result));
  }
  const summary = replay(files["n8n-after_call.json"], { event: "call_analyzed",
    call: { call_id: "demo-call", call_analysis: { call_successful: true, call_summary: "Asked about a brake check and requested a billing callback." } } });
  console.log("Post-call analysis -> " + JSON.stringify(summary));
  console.log("\nSecond blueprint | Juniper Order Desk");
  const orders = await compile(example("order-desk"));
  console.log("Order J-104 -> " + JSON.stringify(replay(orders["n8n-lookup_order.json"], {
    name: "lookup_order", args: { reference: "J-104" }, call: { call_id: "demo-order" },
  })));
}
