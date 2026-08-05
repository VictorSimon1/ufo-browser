function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function defaultJitter(index) {
  return (index * 37) % 180;
}

export async function runCompetition({
  store,
  userCount = 20,
  jitterFor = defaultJitter,
  pause = wait,
} = {}) {
  const results = await Promise.all(
    Array.from({ length: userCount }, async (_, index) => {
      const number = index + 1;
      const delayMs = Math.max(0, Number(jitterFor(index)) || 0);
      const virtualUserId = `VIRTUAL-${String(number).padStart(2, "0")}`;
      await pause(delayMs);

      return {
        virtualUserId,
        name: `虚拟用户 ${String(number).padStart(2, "0")}`,
        delayMs,
        ...store.reserve({
          requestId: `COMPETITION-${virtualUserId}`,
          buyer: `虚拟用户 ${String(number).padStart(2, "0")}`,
        }),
      };
    }),
  );

  const confirmed = results.filter(
    (result) => result.status === "confirmed",
  ).length;
  const soldOut = results.filter(
    (result) => result.status === "sold-out",
  ).length;

  return {
    results,
    summary: {
      total: results.length,
      confirmed,
      soldOut,
      successRate: results.length === 0 ? 0 : confirmed / results.length,
      remaining: store.snapshot().remaining,
    },
  };
}
