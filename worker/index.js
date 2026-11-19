import assets from "./assets.js";
import { addressOf, cleanProfile, day } from "./analytics.js";
import { alertCheckMinutes, checkAlerts, equityAlertLevels } from "./alerts.js";
import { readAlertHealth, readPushHealth, savePushHealth } from "./alert-health.js";
import { cleanSubscription, sendPush } from "./push.js";
import { formatNotificationPreview } from "./notification-format.js";
import { allPerpPositions, hyperliquidInfo } from "./hyperliquid.js";
import { inboxKinds, markInboxRead, readInbox } from "./inbox.js";

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
  return marketResult(() => hyperliquidInfo(payload));
}

async function marketResult(read) {
  try {
    return json(await read());
  } catch (error) {
    if (error.status === 429) {
      return Response.json({ error: error.message }, { status: 429, headers: {
        ...noCache, "Retry-After": String(Math.max(1, Math.ceil(error.retryIn / 1000))),
      } });
    }
    if (error.status) return json({ error: error.message }, error.status);
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
    await env.DB.batch([
      env.DB.prepare("DELETE FROM push_devices WHERE endpoint = ? AND user_id <> ?").bind(subscription.endpoint, user),
      env.DB.prepare("INSERT OR REPLACE INTO push_devices VALUES (?, ?, ?)").bind(user, subscription.endpoint, JSON.stringify(subscription)),
    ]);
    return json({ ok: true });
  }
  if (route === "/api/push-device" && request.method === "DELETE") {
    const data = await body(request, 4000);
    await env.DB.prepare("DELETE FROM push_devices WHERE user_id = ? AND endpoint = ?").bind(user, String(data?.endpoint ?? "")).run();
    return json({ ok: true });
  }
  if (route === "/api/push-status" && request.method === "POST") {
    const data = await body(request, 4000);
    const endpoint = String(data?.endpoint ?? "");
    const row = await env.DB.prepare("SELECT 1 FROM push_devices WHERE user_id = ? AND endpoint = ?")
      .bind(user, endpoint).first();
    return json({ enabled: Boolean(row), push: endpoint ? await readPushHealth(env.DB, user, endpoint) : null });
  }
  if (route === "/api/push-test" && request.method === "POST") {
    if (!env.VAPID_PRIVATE) return json({ error: "推送未配置" }, 503);
    const data = await body(request, 4000);
    const endpoint = String(data?.endpoint ?? "");
    const row = await env.DB.prepare("SELECT subscription FROM push_devices WHERE user_id = ? AND endpoint = ?")
      .bind(user, endpoint).first();
    if (!row) return json({ error: "请先开启本机通知" }, 404);
    try {
      const sample = formatNotificationPreview(data.preview ?? {
        name: "测试钱包", notificationFields: data.notificationFields,
      });
      const status = await sendPush(env, JSON.parse(row.subscription), {
        ...sample, title: "测试 · " + sample.title, tag: "hyper-test", account: user,
      });
      await savePushHealth(env.DB, user, endpoint, status, true);
      if (status === "retry") return json({ error: "推送服务暂时限流，请稍后再试" }, 429);
      return status === "sent" ? json({ ok: true }) : json({ error: "设备订阅已过期" }, 410);
    } catch {
      await savePushHealth(env.DB, user, endpoint, "failed", true);
      return json({ error: "推送服务暂时不可用" }, 502);
    }
  }
  return json({ error: "无效的推送操作" }, 405);
}

function serveAsset(route, method, user) {
  if (method !== "GET" && method !== "HEAD") return json({ error: "请求方法不可用" }, 405);
  const asset = assets[route === "/" ? "/index.html" : route];
  if (!asset) return new Response("Not found", { status: 404, headers: noCache });
  const [mime, contents] = asset;
  const dashboard = route === "/" || route === "/index.html";
  const account = user && /^[a-z0-9][a-z0-9_-]{2,23}$/.test(user) ? user : "";
  const responseBody = dashboard ? contents.replace('data-account=""', 'data-account="' + account + '"')
    : mime.startsWith("image/png") ? Uint8Array.from(atob(contents), c => c.charCodeAt(0)) : contents;
  return new Response(method === "HEAD" ? null : responseBody, {
    headers: { "Content-Type": mime, "Cache-Control": dashboard ? "no-store" : "no-cache", "X-Content-Type-Options": "nosniff" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = url.pathname;
    const user = request.headers.get("oai-authenticated-user-id");
    if (!route.startsWith("/api/")) return serveAsset(route, request.method, user);
    const origin = request.headers.get("origin");
    const crossSite = request.headers.get("sec-fetch-site") === "cross-site";
    if (request.method !== "GET" && (crossSite || (origin && origin !== url.origin))) return json({ error: "请求来源无效" }, 403);
    try {
      if (!user) return json({ error: "请先登录看板" }, 401);
      if (route === "/api/market" && request.method === "POST") return proxyMarket(request);
      if (request.headers.get("x-hyper-account") !== user) return json({ error: "登录账户已变化，请刷新页面" }, 401);
      if (route === "/api/positions" && request.method === "GET") {
        const address = addressOf(url.searchParams.get("wallet"));
        const row = await env.DB.prepare("SELECT settings FROM profiles WHERE user_id = ?").bind(user).first();
        if (!address || !row || !cleanProfile(JSON.parse(row.settings)).wallets.some(wallet => wallet.address === address)) {
          return json({ error: "请先将这个钱包保存到当前账户" }, 404);
        }
        return marketResult(async () => ({ positions: await allPerpPositions(address) }));
      }
      if (route === "/api/run-alerts" && request.method === "POST") return json(await checkAlerts(env, user));
      if (route === "/api/alert-health" && request.method === "GET") {
        return json({ cloud: await readAlertHealth(env.DB, user) });
      }
      if (route === "/api/equity-alert-levels" && request.method === "GET") return json(await equityAlertLevels(env.DB, user));
      if (route === "/api/profile") return await syncProfile(request, env.DB, user);
      if (route.startsWith("/api/push-")) return await pushRoute(request, env, user, route);
      if (route === "/api/inbox" && request.method === "GET") {
        const kind = url.searchParams.get("kind") ?? "all";
        const time = url.searchParams.get("before");
        const id = url.searchParams.get("event");
        if (!inboxKinds.has(kind) || ((time !== null || id !== null) &&
          (!time || !Number.isSafeInteger(Number(time)) || Number(time) < 0 || !id || id.length > 512))) {
          return json({ error: "无效的提醒筛选或分页位置" }, 400);
        }
        return json(await readInbox(env.DB, user, {
          kind, unread: url.searchParams.get("unread") === "1", before: id ? { time: Number(time), id } : null,
        }));
      }
      if (route === "/api/inbox/read" && request.method === "PUT") {
        const { id } = (await body(request, 3000)) ?? {};
        if (typeof id !== "string" || !id || id.length > 512) return json({ error: "无效的提醒编号" }, 400);
        await markInboxRead(env.DB, user, id);
        return json({ ok: true });
      }
      return json({ error: "未找到接口" }, 404);
    } catch (error) {
      return error instanceof RequestError ? json({ error: error.message }, error.status)
        : json({ error: "看板服务暂时不可用" }, 503);
    }
  },
};
