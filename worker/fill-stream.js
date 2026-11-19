import { addressOf, cleanProfile } from "./analytics.js";
import { queueAlertDelivery } from "./alerts.js";
import { flushFillAlerts, recordFillAlerts } from "./trade-alerts.js";
import { recordMarketRows } from "./market-ledger.js";
import { parsePositions } from "./market.js";
import { rememberPositions, forgetPositions } from "./position-source.js";

const url = "wss://api.hyperliquid.xyz/ws";
const maxAddresses = 10;
const initialRetry = 2500;
const channels = ["userFills", "userFundings", "userNonFundingLedgerUpdates", "allDexsClearinghouseState"];

function sendForWallet(socket, method, user) {
  for (const type of channels) {
    socket.send(JSON.stringify({ method, subscription: { type, user, ...(type === "userFills" ? { aggregateByTime: false } : {}) } }));
  }
}

export function startFillStream(env) {
  let targets = new Map();
  let watchedKeys = new Set();
  let socket;
  let reconnect;
  let stopped = false;
  let retry = initialRetry;
  let lastMessage = 0;
  const subscribed = new Set();
  const acknowledged = new Set();

  function reconcile() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const next = new Set([...targets.keys()].slice(0, maxAddresses));
    for (const user of subscribed) {
      if (next.has(user)) continue;
      sendForWallet(socket, "unsubscribe", user);
      forgetPositions(user);
      subscribed.delete(user);
      acknowledged.delete(user);
    }
    for (const user of next) {
      if (subscribed.has(user)) continue;
      sendForWallet(socket, "subscribe", user);
      subscribed.add(user);
    }
  }

  function retryConnection() {
    if (stopped || reconnect || !targets.size) return;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      connect();
    }, retry);
    reconnect.unref();
    retry = Math.min(retry * 2, 30_000);
  }

  async function receive(event) {
    if (typeof event.data !== "string") return;
    const { channel, data } = JSON.parse(event.data);
    if (channel === "subscriptionResponse" && data?.method === "subscribe" && data.subscription?.type === "userFills") {
      const address = addressOf(data.subscription.user);
      if (subscribed.has(address) && !acknowledged.has(address)) {
        acknowledged.add(address);
        console.log("实时成交订阅已确认，钱包数", acknowledged.size);
      }
      return;
    }
    if (channel === "error") {
      console.warn("实时成交订阅返回错误，保留定时补漏。");
      return;
    }
    const address = addressOf(data?.user);
    if (!subscribed.has(address)) return;
    if (channel === "allDexsClearinghouseState") {
      rememberPositions(address, parsePositions(data.clearinghouseStates));
      return;
    }
    if (channel === "userFundings") {
      await recordMarketRows(env.DB, address, "funding", data.fundings);
      return;
    }
    if (channel === "userNonFundingLedgerUpdates") {
      await recordMarketRows(env.DB, address, "ledger", data.nonFundingLedgerUpdates ?? data.ledgerUpdates);
      return;
    }
    if (channel !== "userFills" || !Array.isArray(data.fills)) return;
    // Archiving must never prevent the existing real-time reminder path.
    await recordMarketRows(env.DB, address, "fill", data.fills)
      .catch(() => console.warn("实时成交存档稍后由 REST 补齐。"));
    if (data.isSnapshot === true) return;
    const watchers = targets.get(address) ?? [];
    const outcomes = await Promise.allSettled(watchers.map(async ({ user, wallet, rules }) => {
      if (await recordFillAlerts(env.DB, user, wallet, rules, data.fills)) {
        await flushFillAlerts(env.DB, Date.now(), user);
        await queueAlertDelivery(env, user);
      }
    }));
    if (outcomes.some(outcome => outcome.status === "rejected")) {
      console.warn("实时成交提醒处理失败，定时扫描会补查。");
    }
  }

  function connect() {
    if (stopped || socket || !targets.size) return;
    let current;
    try {
      current = new WebSocket(url);
    } catch {
      retryConnection();
      return;
    }
    socket = current;
    lastMessage = Date.now();
    current.addEventListener("open", () => {
      if (socket !== current) return;
      retry = initialRetry;
      lastMessage = Date.now();
      reconcile();
    });
    current.addEventListener("message", event => {
      if (socket !== current) return;
      lastMessage = Date.now();
      receive(event).catch(() => console.warn("实时成交消息处理失败，定时扫描会补查。"));
    });
    current.addEventListener("close", () => {
      if (socket !== current) return;
      socket = undefined;
      for (const address of subscribed) forgetPositions(address);
      subscribed.clear();
      acknowledged.clear();
      retryConnection();
    });
  }

  async function refreshTargets() {
    const { results } = await env.DB.prepare("SELECT user_id, settings FROM profiles ORDER BY rowid").all();
    if (stopped) return;
    const next = new Map();
    const nextKeys = new Set();
    const newWatches = [];
    const allAddresses = new Set();
    const ownAddresses = new Set();
    for (const { user_id: user, settings } of results) {
      const { wallets, rules } = cleanProfile(JSON.parse(settings));
      for (const wallet of wallets) {
        allAddresses.add(wallet.address);
        if (wallet.role === "mine") ownAddresses.add(wallet.address);
      }
      if (!rules.actions.length) continue;
      for (const wallet of wallets.filter(wallet => wallet.notify)) {
        if (!next.has(wallet.address)) next.set(wallet.address, []);
        next.get(wallet.address).push({ user, wallet, rules });
        const key = user + ":" + wallet.address;
        nextKeys.add(key);
        if (!watchedKeys.has(key)) {
          newWatches.push(env.DB.prepare("INSERT OR IGNORE INTO alert_status VALUES (?, ?, ?, '[]')")
            .bind(user, "fills:" + wallet.address, Date.now() - 3000));
        }
      }
    }
    for (const address of [...ownAddresses, ...allAddresses]) {
      if (!next.has(address)) next.set(address, []);
    }
    if (newWatches.length) await env.DB.batch(newWatches);
    if (stopped) return;
    watchedKeys = nextKeys;
    targets = next;
    if (!socket && !reconnect) connect();
    reconcile();
  }

  const refresh = () => refreshTargets().catch(() => console.warn("实时成交订阅列表读取失败。"));
  const poll = setInterval(refresh, 5000);
  let flushing = false;
  const flush = setInterval(async () => {
    if (flushing) return;
    flushing = true;
    try {
      const accounts = await flushFillAlerts(env.DB);
      for (const user of accounts) {
        queueAlertDelivery(env, user).catch(() => console.warn("合并成交提醒将稍后重试。"));
      }
    } catch {
      console.warn("合并成交提醒处理失败，将自动重试。");
    } finally {
      flushing = false;
    }
  }, 1000);
  const heartbeat = setInterval(() => {
    if (!socket) return;
    if (Date.now() - lastMessage > 45_000) {
      socket.close();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send('{"method":"ping"}');
  }, 15_000);
  poll.unref();
  flush.unref();
  heartbeat.unref();
  refresh();

  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(flush);
    clearInterval(heartbeat);
    clearTimeout(reconnect);
    socket?.close();
  };
}
