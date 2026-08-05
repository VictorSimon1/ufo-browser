export function createTicketStore({
  capacity,
  saleAt = Date.now(),
  now = Date.now,
}) {
  let remaining = capacity;
  let sequence = 0;
  const orders = new Map();

  return {
    reserve({ requestId, buyer, performanceId, priceTierId, attendeeId }) {
      if (orders.has(requestId)) {
        return orders.get(requestId);
      }

      if (now() < saleAt) {
        return { status: "too-early", requestId, buyer, remaining, saleAt };
      }

      if (remaining === 0) {
        return { status: "sold-out", requestId, buyer, remaining };
      }

      remaining -= 1;
      sequence += 1;

      const result = {
        status: "confirmed",
        orderId: `EGO-${String(sequence).padStart(4, "0")}`,
        requestId,
        buyer,
        selection: { performanceId, priceTierId, attendeeId },
        remaining,
      };
      orders.set(requestId, result);
      return result;
    },

    snapshot() {
      return { capacity, remaining, saleAt };
    },
  };
}
