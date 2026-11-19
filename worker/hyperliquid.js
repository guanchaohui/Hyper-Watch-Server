import { retryAfterMs } from "./retry.js";
import { parsePositions } from "./market.js";

const endpoint = "https://api.hyperliquid.xyz/info";
const minute = 60_000;
const snapshotTtl = 4_000;
const snapshotLimit = 128;
// Hyperliquid budgets REST by IP. Leave room for other traffic and reserve part
// of the app's budget for alert scans before admitting interactive queries.
const budget = 1_000;
const interactiveBudget = 720;
const weightByType = { clearinghouseState: 2, spotClearinghouseState: 2, portfolio: 20, perpDexs: 20 };
const dexListTtl = 5 * minute;
const calls = [];
const cached = new Map();
const pending = new Map();
let blockedUntil = 0;

class HyperliquidError extends Error {
  constructor(message, status, retryIn) {
    super(message);
    this.status = status;
    this.retryIn = retryIn;
  }
}

function reserve(type, priority, now) {
  if (now < blockedUntil) throw new HyperliquidError("Hyperliquid 请求暂时限流", 429, blockedUntil - now);
  while (calls.length && now - calls[0].at >= minute) calls.shift();
  const baseWeight = weightByType[type] ?? 20;
  // Timed history queries can return up to 2,000 rows. Reserve the
  // response weight while in flight, then account for the actual row count.
  const weight = weightByType[type] === undefined ? 120 : baseWeight;
  let total = 0;
  let interactive = 0;
  for (const call of calls) {
    total += call.weight;
    if (!call.priority) interactive += call.weight;
  }
  if (total + weight > budget || (!priority && interactive + weight > interactiveBudget)) {
    throw new HyperliquidError("Hyperliquid 请求暂时限流", 429, 5000);
  }
  const call = { at: now, weight, priority };
  calls.push(call);
  return call;
}

async function perform(payload, priority, key) {
  const call = reserve(payload.type, priority, Date.now());
  const response = await fetch(endpoint, {
    method: "POST",
    body: key,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(9_500),
    redirect: "error",
  });
  if (response.status === 429) {
    const now = Date.now();
    blockedUntil = Math.max(blockedUntil, now + retryAfterMs(response.headers.get("retry-after"), minute, now));
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) throw new HyperliquidError("Hyperliquid HTTP 429", 429, blockedUntil - Date.now());
    throw new HyperliquidError("Hyperliquid HTTP " + response.status, 502);
  }
  const data = await response.json();
  if (weightByType[payload.type] === undefined && Array.isArray(data)) {
    call.weight = 20 + Math.ceil(data.length / 20);
  }
  return data;
}

export async function hyperliquidInfo(payload, priority = false) {
  const snapshot = Object.hasOwn(weightByType, payload.type);
  const key = JSON.stringify(payload);
  const hit = cached.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (pending.has(key)) return pending.get(key);

  const promise = perform(payload, priority, key).then(data => {
    if (snapshot) {
      cached.delete(key);
      if (cached.size >= snapshotLimit) cached.delete(cached.keys().next().value);
      cached.set(key, { data, expires: Date.now() + (payload.type === "perpDexs" ? dexListTtl : snapshotTtl) });
    }
    return data;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export async function allPerpPositions(address, priority = false) {
  const registry = await hyperliquidInfo({ type: "perpDexs" }, priority);
  if (!Array.isArray(registry) || registry[0] !== null ||
      !registry.every(dex => dex === null || (typeof dex?.name === "string" && dex.name))) {
    throw new Error("Invalid perpetual exchange list");
  }
  const markets = new Set(["", ...registry.filter(Boolean).map(dex => dex.name)]);
  const states = await Promise.all([...markets].map(async dex => [dex,
    await hyperliquidInfo({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) }, priority),
  ]));
  return parsePositions(states);
}
