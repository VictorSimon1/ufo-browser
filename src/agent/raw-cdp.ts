export function assertRawCdpPayload(payload: unknown): string {
  if (typeof payload !== "string") {
    throw new TypeError(
      "sendCDPMessage expects one JSON string payload; prefer cdp(method, params) for normal commands",
    );
  }
  let message: any;
  try {
    message = JSON.parse(payload);
  } catch {
    throw new TypeError(
      "sendCDPMessage expects JSON.stringify({ id, method, params }); prefer cdp(method, params)",
    );
  }
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    (typeof message.id !== "number" && typeof message.id !== "string") ||
    typeof message.method !== "string" ||
    !message.method.trim()
  ) {
    throw new TypeError(
      "sendCDPMessage payload must be JSON.stringify({ id, method, params }); prefer cdp(method, params)",
    );
  }
  if (
    message.params !== undefined &&
    (!message.params ||
      typeof message.params !== "object" ||
      Array.isArray(message.params))
  ) {
    throw new TypeError("sendCDPMessage payload.params must be an object");
  }
  return payload;
}
