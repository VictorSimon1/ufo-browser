const ticketViews = {
  scheduled: { actionLabel: "等待开售", disabled: true, statusLabel: "候场中" },
  "on-sale": {
    actionLabel: "提交抢票",
    disabled: false,
    statusLabel: "正在售票",
  },
  "sold-out": {
    actionLabel: "本轮已售罄",
    disabled: true,
    statusLabel: "已售罄",
  },
};

export function deriveTicketView(event) {
  return ticketViews[event.status] || ticketViews.scheduled;
}

export function formatCountdown(milliseconds) {
  const safeMilliseconds = Math.max(0, milliseconds);
  const seconds = Math.floor(safeMilliseconds / 1_000);
  const tenths = Math.floor((safeMilliseconds % 1_000) / 100);
  return `00:${String(seconds).padStart(2, "0")}.${tenths}`;
}
