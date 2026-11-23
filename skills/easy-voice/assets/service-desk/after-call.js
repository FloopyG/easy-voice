// A CRM-ready fixture. Replace this node with a durable, idempotent upsert in a live integration.
return { json: {
  status: "summary_draft",
  call_id: $json.call_id,
  outcome: $json.args.call_successful ?? null,
  summary: $json.args.call_summary ?? null,
  idempotency_key: $json.idempotency_key,
} };
