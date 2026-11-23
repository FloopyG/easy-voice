// Fictional catalog. n8n supplies the validated tool arguments in $json.args.
const services = new Map([
  ["brake check", { service: "Brake check", minutes: 30 }],
  ["wheel alignment", { service: "Wheel alignment", minutes: 60 }],
]);
const match = services.get($json.args.service.trim().toLowerCase());
return { json: match ? { status: "found", ...match } : { status: "unknown_service" } };
