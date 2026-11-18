import assets from "./assets.js";
import { addressOf, cleanProfile, day } from "./analytics.js";
import { alertCheckMinutes, checkAlerts } from "./alerts.js";
import { cleanSubscription, sendPush } from "./push.js";

const sourceApi = "https://api.hyperliquid.xyz/info";
const marketTypes = new Set(["portfolio", "clearinghouseState", "spotClearinghouseState", "userFillsByTime", "userFunding", "userNonFundingLedgerUpdates"]);
const timedTypes = new Set(["userFillsByTime", "userFunding", "userNonFundingLedgerUpdates"]);
const noCache = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (data, status = 200) => Response.json(data, { status, headers: noCache });

async function body(request, maximum = 20000) {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new RequestError("需要 JSON 请求", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("缺少请求内容", 400);
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maximum) {
        await reader.cancel();
        throw new RequestError("请求内容太长", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("请求格式无效", 400);
  } finally {
    reader.releaseLock();
  }
}

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function proxyMarket(request) {
  const raw = await body(request, 1000);
  const user = addressOf(raw?.user);
  if (!user || !marketTypes.has(raw?.type)) return json({ error: "不支持该只读查询" }, 400);
  const payload = { type: raw.type, user };
  if (timedTypes.has(raw.type)) {
    const now = Date.now();
    const start = Number(raw.startTime);
    if (!Number.isSafeInteger(start) || start > now || start < now - 32 * day) return json({ error: "查询时间超出范围" }, 400);
    payload.startTime = start;
    payload.endTime = Math.min(now, Number.isSafeInteger(raw.endTime) ? Math.max(start, raw.endTime) : now);
    if (raw.type === "userFillsByTime") payload.aggregateByTime = true;
  }
  try {
    const result = await fetch(sourceApi, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(9500),
      redirect: "error",
    });
    if (!result.ok) return json({ error: "Hyperliquid HTTP " + result.status }, result.status === 429 ? 429 : 502);
    return new Response(result.body, { headers: { "Content-Type": "application/json", ...noCache } });
  } catch (error) {
    return json({ error: "看板无法连接 Hyperliquid" }, error.name === "TimeoutError" ? 504 : 502);
  }
}

async function syncProfile(request, db, user) {
  if (request.method === "GET") {
    const row = await db.prepare("SELECT settings, revision FROM profiles WHERE user_id = ?").bind(user).first();
    return json({ profile: row ? cleanProfile(JSON.parse(row.settings)) : null, revision: row?.revision ?? 0 });
  }
  if (request.method !== "PUT") return json({ error: "请求方法不可用" }, 405);
  const data = await body(request);
  if (!Number.isSafeInteger(data?.revision) || data.revision < 0 || !data.profile || typeof data.profile !== "object") {
    return json({ error: "无效的设置版本" }, 400);
  }
  const profile = cleanProfile(data.profile);
  const settings = JSON.stringify(profile);
  const revision = data.revision + 1;
  const write = data.revision === 0
    ? await db.prepare("INSERT OR IGNORE INTO profiles VALUES (?, ?, 1)").bind(user, settings).run()
    : await db.prepare("UPDATE profiles SET settings = ?, revision = ? WHERE user_id = ? AND revision = ?")
      .bind(settings, revision, user, data.revision).run();
  if (!write.meta.changes) {
    const current = await db.prepare("SELECT settings, revision FROM profiles WHERE user_id = ?").bind(user).first();
    return json({ profile: current ? cleanProfile(JSON.parse(current.settings)) : null, revision: current?.revision ?? 0 }, 409);
  }
  return json({ profile, revision });
}

async function pushRoute(request, env, user, route) {
  if (route === "/api/push-config" && request.method === "GET") {
    return json({ publicKey: env.VAPID_PUBLIC ?? null, interval: env.ALERT_INTERVAL_MINUTES ?? alertCheckMinutes });
  }
  if (route === "/api/push-device" && request.method === "POST") {
    const subscription = cleanSubscription(await body(request, 6000));
    if (!subscription) return json({ error: "无效的设备订阅" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO push_devices VALUES (?, ?, ?)").bind(user, subscription.endpoint, JSON.stringify(subscription)).run();
    return json({ ok: true });
  }
  if (route === "/api/push-device" && request.method === "DELETE") {
    const data = await body(request, 4000);
    await env.DB.prepare("DELETE FROM push_devices WHERE user_id = ? AND endpoint = ?").bind(user, String(data?.endpoint ?? "")).run();
    return json({ ok: true });
  }
  if (route === "/api/push-test" && request.method === "POST") {
    if (!env.VAPID_PRIVATE) return json({ error: "推送未配置" }, 503);
    const data = await body(request, 4000);
    const row = await env.DB.prepare("SELECT subscription FROM push_devices WHERE user_id = ? AND endpoint = ?")
      .bind(user, String(data?.endpoint ?? "")).first();
    if (!row) return json({ error: "请先开启本机通知" }, 404);
    try {
      const status = await sendPush(env, JSON.parse(row.subscription), { title: "Hyper 盯盘", body: "本机推送测试", tag: "hyper-test" });
      return status === "sent" ? json({ ok: true }) : json({ error: "设备订阅已过期" }, 410);
    } catch {
      return json({ error: "推送服务暂时不可用" }, 502);
    }
  }
  return json({ error: "无效的推送操作" }, 405);
}

function serveAsset(route, method) {
  if (method !== "GET" && method !== "HEAD") return json({ error: "请求方法不可用" }, 405);
  const asset = assets[route === "/" ? "/index.html" : route];
  if (!asset) return new Response("Not found", { status: 404, headers: noCache });
  const [mime, contents] = asset;
  const responseBody = mime.startsWith("image/png") ? Uint8Array.from(atob(contents), c => c.charCodeAt(0)) : contents;
  return new Response(method === "HEAD" ? null : responseBody, {
    headers: { "Content-Type": mime, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = url.pathname;
    if (!route.startsWith("/api/")) return serveAsset(route, request.method);
    const user = request.headers.get("oai-authenticated-user-id");
    const origin = request.headers.get("origin");
    const crossSite = request.headers.get("sec-fetch-site") === "cross-site";
    if (request.method !== "GET" && (crossSite || (origin && origin !== url.origin))) return json({ error: "请求来源无效" }, 403);
    try {
      if (!user) return json({ error: "请先登录看板" }, 401);
      if (route === "/api/run-alerts" && request.method === "POST") return json(await checkAlerts(env));
      if (route === "/api/market" && request.method === "POST") return proxyMarket(request);
      if (route === "/api/profile") return await syncProfile(request, env.DB, user);
      if (route.startsWith("/api/push-")) return await pushRoute(request, env, user, route);
      if (route === "/api/inbox" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT event_id AS id, body, created_at AS time FROM alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 60").bind(user).all();
        return json({ items: results });
      }
      return json({ error: "未找到接口" }, 404);
    } catch (error) {
      return error instanceof RequestError ? json({ error: error.message }, error.status)
        : json({ error: "看板服务暂时不可用" }, 503);
    }
  },
};
