// Fictional records. A real order integration must also authorize access to the order.
const orders = new Map([["J-104", "ready for pickup"], ["J-205", "processing"]]);
const state = orders.get($json.args.reference.trim().toUpperCase());
return { json: state ? { status: "found", state } : { status: "not_found" } };
