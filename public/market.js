import { addressOf, numberOf } from "./analytics.js";
export { addressOf, numberOf };
const api = "https://api.hyperliquid.xyz/info";
const wsApi = "wss://api.hyperliquid.xyz/ws";
export const periods = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  allTime: 180 * 24 * 60 * 60 * 1000,
};

function pointsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const points = new Map();
  for (const pair of raw) {
    if (!Array.isArray(pair)) continue;
    const time = numberOf(pair[0]);
    const value = numberOf(pair[1]);
    if (time > 0 && value !== null) points.set(time, value);
  }
  return [...points].sort(([a], [b]) => a - b);
}

export function parsePortfolio(raw) {
  if (!Array.isArray(raw)) throw new Error("Invalid portfolio response");
  const history = {};
  for (const row of raw) {
    if (!Array.isArray(row) || !Object.hasOwn(periods, row[0])) continue;
    history[row[0]] = {
      equity: pointsOf(row[1]?.accountValueHistory),
      pnl: pointsOf(row[1]?.pnlHistory),
    };
  }
  return history;
}

export function parsePositions(states) {
  if (!Array.isArray(states) || !states.every(row => Array.isArray(row) && Array.isArray(row[1]?.assetPositions))) {
    throw new Error("Invalid position response");
  }
  return states.flatMap(([dex, state]) => state.assetPositions.flatMap(({ position }) => {
    const size = numberOf(position?.szi);
    if (!position?.coin || !size) return [];
    const value = numberOf(position.positionValue);
    return [{
      coin: position.coin,
      dex,
      size,
      value: value === null ? null : Math.abs(value),
      entry: numberOf(position.entryPx),
      mark: value === null ? null : Math.abs(value / size),
      pnl: numberOf(position.unrealizedPnl),
      leverage: numberOf(position.leverage?.value),
      mode: position.leverage?.type ?? null,
      margin: numberOf(position.marginUsed),
      liquidation: numberOf(position.liquidationPx),
    }];
  })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

export function parseSpot(raw) {
  if (!Array.isArray(raw?.balances)) throw new Error("Invalid spot response");
  return raw.balances.flatMap(balance => {
    const total = numberOf(balance.total);
    const hold = numberOf(balance.hold);
    return balance.coin && (total || hold) ? [{ coin: balance.coin, total, hold }] : [];
  }).sort((a, b) => Number(b.coin === "USDC") - Number(a.coin === "USDC") || a.coin.localeCompare(b.coin));
}

export async function queryInfo(type, user, sessionSignal, parameters = {}, endpoint = api) {
  const attempt = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; attempt.abort(); }, 10500);
  const cancel = () => attempt.abort();
  if (sessionSignal?.aborted) cancel();
  else sessionSignal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...parameters, type, user }),
      credentials: "same-origin",
      signal: attempt.signal,
    });
    if (!response.ok) throw Object.assign(new Error("数据接口返回 HTTP " + response.status), { status: response.status });
    return await response.json();
  } catch (error) {
    if (timedOut) throw Object.assign(new Error("请求超时"), { timeout: true });
    throw error;
  } finally {
    clearTimeout(timer);
    sessionSignal?.removeEventListener("abort", cancel);
  }
}

export async function info(type, user, signal, parameters = {}) {
  if (typeof document !== "undefined" && document.documentElement.dataset.runtime === "site") {
    try {
      return await queryInfo(type, user, signal, parameters, "/api/market");
    } catch (error) {
      if (signal?.aborted || error.status === 429 || (error.status >= 400 && error.status < 500 && error.status !== 404)) throw error;
    }
  }
  return queryInfo(type, user, signal, parameters);
}

export function connectPerps(user, onPositions, onState) {
  if (!("WebSocket" in globalThis)) return () => {};
  let active = true;
  let socket = null;
  let heartbeat = null;
  let reconnect = null;
  let retryDelay = 1500;

  function open() {
    if (!active) return;
    try {
      socket = new WebSocket(wsApi);
    } catch {
      retry();
      return;
    }
    const current = socket;
    let lastMessage = Date.now();
    current.addEventListener("open", () => {
      if (!active) return;
      current.send(JSON.stringify({ method: "subscribe", subscription: { type: "allDexsClearinghouseState", user } }));
    });
    current.addEventListener("message", event => {
      if (!active) return;
      try {
        const message = JSON.parse(event.data);
        lastMessage = Date.now();
        if (message.channel === "allDexsClearinghouseState" && addressOf(message.data?.user) === user) {
          const positions = parsePositions(message.data.clearinghouseStates);
          retryDelay = 1500;
          onPositions(positions);
        }
      } catch {
        // Keep the last valid snapshot.
      }
    });
    heartbeat = setInterval(() => {
      if (Date.now() - lastMessage > 45000) {
        current.close();
      } else if (current.readyState === WebSocket.OPEN) {
        current.send(JSON.stringify({ method: "ping" }));
      }
    }, 15000);
    current.addEventListener("close", () => {
      if (!active) return;
      clearInterval(heartbeat);
      onState();
      retry();
    });
  }

  function retry() {
    reconnect = setTimeout(open, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }

  open();
  return () => {
    active = false;
    clearInterval(heartbeat);
    clearTimeout(reconnect);
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  };
}

const demoMovement = [
  0, -68, -28, -110, -142, -78, -105, -130, -78, -12, -39, 45, 16, 55, 3, 77,
  48, 100, 59, 164, 118, 145, 120, 81, 113, 91, 137, 236, 196, 245, 213, 278,
  231, 306, 275, 340, 296, 205, 274, 253, 297, 272, 367, 344, 426, 382, 398, 432.68,
];

export function demoData(now = Date.now()) {
  const end = 24856.42;
  const movement = { day: 432.68, week: 1196, month: 2830, allTime: 9850 };
  const amplitude = { day: 1, week: 2.3, month: 4.5, allTime: 8 };
  const history = Object.fromEntries(Object.entries(periods).map(([key, duration]) => {
    const scale = amplitude[key];
    const start = end - movement[key];
    const equity = demoMovement.map((v, i) => {
      const progress = i / (demoMovement.length - 1);
      const variation = (v - 432.68 * progress) * scale;
      return [Math.round(now - duration * (1 - progress)), start + movement[key] * progress + variation];
    });
    return [key, { equity, pnl: equity.map(([time, v]) => [time, v - start]) }];
  }));
  const positions = [
    { coin: "BTC", dex: "", size: 0.32, value: 21916.8, entry: 67872.4375, mark: 68490, pnl: 197.62, leverage: 5 },
    { coin: "ETH", dex: "", size: -4.5, value: 16509.60, entry: 3696.4111, mark: 3668.80, pnl: 124.25, leverage: 8 },
    { coin: "SOL", dex: "", size: 36, value: 6188.04, entry: 172.83, mark: 171.89, pnl: -33.84, leverage: 3 },
  ];
  const spot = [{ coin: "USDC", total: 5820.42, hold: 120 }, { coin: "HYPE", total: 84, hold: 0 }];
  return { history, positions, spot };
}
