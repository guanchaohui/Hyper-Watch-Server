import { monitoredWallets, recordMarketRows } from "./market-ledger.js";

export function startOrderStreams(db) {
  const sockets = new Map();
  let stopped = false, busy = false;
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const wallets = new Set((await monitoredWallets(db, true)).slice(0, 3));
      if (stopped) return;
      const now = Date.now();
      for (const [wallet, entry] of sockets) {
        if (!wallets.has(wallet)) {
          sockets.delete(wallet);
          entry.socket?.close();
        } else if (entry.socket && now - entry.last > 45_000) entry.socket.close();
      }
      for (const wallet of wallets) {
        const prior = sockets.get(wallet);
        if (prior?.socket || prior?.retryAt > now) continue;
        const socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
        const entry = { socket, last: now, retryAt: now + 12_000 };
        sockets.set(wallet, entry);
        socket.addEventListener("open", () => {
          if (sockets.get(wallet) === entry) socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "orderUpdates", user: wallet } }));
        });
        socket.addEventListener("message", event => {
          if (sockets.get(wallet) !== entry) return;
          entry.last = Date.now();
          try {
            const { channel, data } = JSON.parse(event.data);
            if (channel === "orderUpdates" && Array.isArray(data)) {
              recordMarketRows(db, wallet, "order", data).catch(() => console.warn("订单状态存档待补同步。"));
            }
          } catch { /* Ignore malformed upstream messages. */ }
        });
        socket.addEventListener("close", () => {
          if (sockets.get(wallet) === entry) {
            entry.socket = null;
            entry.retryAt = Date.now() + 12_000;
          }
        });
      }
    } catch {
      console.warn("订单实时连接暂不可用，保留 REST 同步。");
    } finally { busy = false; }
  }
  const poll = setInterval(tick, 5000);
  const heartbeat = setInterval(() => {
    for (const { socket } of sockets.values()) {
      if (socket?.readyState === WebSocket.OPEN) socket.send('{"method":"ping"}');
    }
  }, 15_000);
  poll.unref();
  heartbeat.unref();
  tick();
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    for (const { socket } of sockets.values()) socket?.close();
    sockets.clear();
  };
}
