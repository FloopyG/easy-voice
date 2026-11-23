// This function is also embedded in the generated n8n Code node. Keep it self-contained.
export function acceptRequest(body, tool, contextFields) {
  const fail = (detail) => ({ status: "invalid_input", detail });
  if (!body || body.name !== tool.name) return fail("Unexpected tool name.");
  const args = body.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("Expected an args object.");

  const properties = tool.parameters.properties;
  for (const name of tool.parameters.required) {
    if (!Object.hasOwn(args, name)) return fail("Missing " + name + ".");
  }
  for (const [name, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, name)) return fail("Unexpected argument.");
    const field = properties[name];
    const typeOK = field.type === "integer" ? Number.isSafeInteger(value) :
      field.type === "number" ? Number.isFinite(value) : typeof value === field.type;
    if (!typeOK || (field.type === "string" && !value.trim())) return fail("Invalid " + name + ".");
    if (field.enum && !field.enum.includes(value)) return fail("Unsupported " + name + ".");
  }
  if (tool.confirm && args.confirmed !== true) return { status: "needs_confirmation" };

  const callId = body.call?.call_id;
  if (tool.keyFields.length && (typeof callId !== "string" || !callId.trim())) return fail("Missing call identity.");
  const context = {};
  for (const name of contextFields) {
    const metadata = body.call?.metadata;
    if (metadata && Object.hasOwn(metadata, name)) {
      const value = metadata[name];
      if (["string", "boolean", "number"].includes(typeof value)) context[name] = value;
    }
  }
  const result = { status: "ready", args, context, call_id: typeof callId === "string" ? callId : null };
  if (tool.keyFields.length) {
    result.idempotency_key = JSON.stringify([callId, tool.name, ...tool.keyFields.map((key) => args[key])]);
  }
  return result;
}

// Convert a signed lifecycle webhook to the same small adapter interface as a voice tool.
export function eventRequest(body, expectedEvent, includeSummary = false) {
  if (body?.event !== expectedEvent || !body.call) return null;
  const call = body.call;
  const args = { event: expectedEvent };
  for (const key of ["call_status", "disconnection_reason", "duration_ms"]) {
    if (call[key] != null) args[key] = call[key];
  }
  for (const key of ["call_successful", "user_sentiment"]) {
    if (call.call_analysis?.[key] != null) args[key] = call.call_analysis[key];
  }
  if (includeSummary && typeof call.call_analysis?.call_summary === "string" && call.call_analysis.call_summary.trim()) {
    args.call_summary = call.call_analysis.call_summary;
  }
  return { name: "after_call", args, call };
}

const scalarTypes = new Set(["string", "boolean", "number", "integer"]);
const identifier = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export function safeField(name) {
  return typeof name === "string" && identifier.test(name) && !["constructor", "prototype", "__proto__"].includes(name);
}

export function compileTool(input) {
  if (!input || typeof input.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(input.name) || input.name === "end_call") {
    throw new Error("Tool names must be unique lower-case identifiers. end_call is reserved.");
  }
  if (typeof input.description !== "string" || !input.description.trim()) throw new Error(input.name + " needs a description.");
  if (input.confirm !== undefined && typeof input.confirm !== "boolean") throw new Error(input.name + ".confirm must be boolean.");
  const schema = input.parameters;
  if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" ||
      Array.isArray(schema.properties)) throw new Error(input.name + " needs an object schema with properties.");
  if (Object.keys(schema).some(k => !["type", "properties", "required", "additionalProperties", "description"].includes(k)) ||
      (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) {
    throw new Error(input.name + " uses an unsupported root schema keyword or open-ended arguments.");
  }
  const properties = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!safeField(name) || !field || !scalarTypes.has(field.type) ||
        Object.keys(field).some(k => !["type", "description", "enum"].includes(k)) ||
        (field.description !== undefined && typeof field.description !== "string")) throw new Error("Invalid field: " + name);
    if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length ||
        field.enum.some(v => field.type === "integer" ? !Number.isSafeInteger(v) :
          field.type === "number" ? !Number.isFinite(v) : typeof v !== field.type))) throw new Error("Invalid enum: " + name);
    properties[name] = { ...field };
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(k => typeof k !== "string" || !Object.hasOwn(properties, k)) ||
      new Set(required).size !== required.length) throw new Error("Invalid required fields: " + input.name);
  if (input.confirm) {
    if (Object.hasOwn(properties, "confirmed")) throw new Error("Easy Voice supplies the confirmed field for " + input.name);
    properties.confirmed = { type: "boolean", description: "True only after the caller explicitly confirms this specific action." };
  }
  const keyFields = input.keyFields ?? [];
  if (!Array.isArray(keyFields) || keyFields.some(k => !required.includes(k)) || new Set(keyFields).size !== keyFields.length) {
    throw new Error("keyFields must name distinct, required business arguments: " + input.name);
  }
  return {
    name: input.name, description: input.description, confirm: input.confirm === true, keyFields,
    parameters: { type: "object", properties, required: input.confirm ? [...required, "confirmed"] : [...required], additionalProperties: false },
  };
}
