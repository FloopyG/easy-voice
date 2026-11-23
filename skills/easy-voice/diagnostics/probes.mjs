// These reads mirror the checks the skill makes through the coding agent's own MCP connections.
export const providers = ["retell", "n8n"];

export function failureState(error) {
  const message = [error?.status, error?.statusCode, error?.code, error?.cause?.code, error?.name, error?.message].join(" ");
  if (/user (denied|declined|rejected)|approval (denied|required)|tool permission/i.test(message)) return "approval";
  if (/ssrf protection|blocked in strict mode/i.test(message)) return "network-policy";
  if (/\b403\b|forbidden|authorization_error|insufficient.scope|insufficient.permissions|permission denied/i.test(message)) return "permission";
  if (/\b401\b|unauthorized|authentication_error|invalid.api.key|authorization header required/i.test(message)) return "credentials";
  if (/not configured|api (credentials|key).*missing/i.test(message)) return "setup";
  if (/timeout|timed out|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|connection closed|\b429\b|\b5\d\d\b|rate.limit|network_error|no_response|server_error/i.test(message)) return "unavailable";
  return "unverified";
}

function unpack(reply) {
  const text = reply?.content?.find(item => item.type === "text")?.text;
  let data = reply?.structuredContent;
  if (data == null && text) {
    try { data = JSON.parse(text); } catch { /* Non-JSON error messages are classified below. */ }
  }
  if (reply?.isError || data?.success === false || data?.error || data?.error_message) {
    const detail = data?.error;
    const error = new Error(detail?.message ?? (typeof detail === "string" ? detail : data?.error_message ?? text));
    error.code = data?.code ?? detail?.code;
    error.status = data?.status ?? detail?.status;
    throw error;
  }
  return data;
}

export async function probeAccount(provider, client, signal = AbortSignal.timeout(20000)) {
  if (!client) return "setup";
  const options = { signal, timeout: 20000 };
  async function call(name, args) {
    return unpack(await client.callTool({ name, arguments: args }, undefined, options));
  }
  try {
    const names = new Set();
    const seen = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, options);
      for (const tool of page.tools) names.add(tool.name);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) return "unverified";
      seen.add(cursor);
    } while (cursor);

    if (provider === "n8n") {
      if (!names.has("n8n_list_workflows")) {
        return names.has("tools_documentation") || names.has("validate_workflow") ? "docs-only" : "unsupported";
      }
      const result = await call("n8n_list_workflows", { limit: 1, excludePinnedData: true });
      return result?.success === true && Array.isArray(result.data?.workflows) ? "connected" : "unverified";
    }
    if (provider !== "retell" || !["list_api_endpoints", "get_api_endpoint_schema", "invoke_api_endpoint"].every(name => names.has(name))) return "unsupported";
    const path = "/get-concurrency";
    const catalog = await call("list_api_endpoints", { search: path });
    const matches = catalog?.endpoints?.filter(entry => entry.path === path && entry.method === "GET");
    if (matches?.length !== 1 || !matches[0].endpoint) return "unverified";
    const endpoint = matches[0].endpoint;
    const schema = await call("get_api_endpoint_schema", { endpoint });
    if (schema?.endpoint !== endpoint || schema.method !== "GET" || schema.path !== path ||
        schema.input_schema?.type !== "object" || schema.input_schema.required?.length) return "unverified";
    const result = await call("invoke_api_endpoint", { endpoint, arguments: {} });
    const body = result?.body ?? result?.data ?? result?.response ?? result;
    return [body?.current_concurrency, body?.concurrency_limit].every(n => Number.isInteger(n) && n >= 0)
      ? "connected" : "unverified";
  } catch (error) {
    return failureState(error);
  }
}
