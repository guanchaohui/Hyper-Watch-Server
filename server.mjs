import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import worker from "./dist/server/index.js";
import { checkAlerts } from "./dist/server/alerts.js";

const publicUrl = new URL(process.env.PUBLIC_ORIGIN || "file:///");
if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash ||
  publicUrl.username || publicUrl.password) throw new Error("PUBLIC_ORIGIN 必须是 HTTPS 网站根地址。");
const publicOrigin = publicUrl.origin;
const [salt, configuredHash] = (process.env.HYPER_PASSWORD_HASH || "").split(".");
const expectedHash = Buffer.from(configuredHash ?? "", "base64url");
const sessionKey = Buffer.from(process.env.HYPER_SESSION_KEY || "", "base64url");
if (Buffer.from(salt ?? "", "base64url").length !== 24 || expectedHash.length !== 48 || sessionKey.length !== 48) {
  throw new Error("登录配置无效，请通过 init.sh 生成配置。");
}
const interval = Number(process.env.HYPER_ALERT_MINUTES || 5);
if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
  throw new Error("HYPER_ALERT_MINUTES 须为 1 至 1440 的整数。");
}

const directory = resolve(process.env.DATA_DIR || "data");
await mkdir(directory, { recursive: true, mode: 0o700 });
const sqlite = new DatabaseSync(resolve(directory, "hyper-watch.sqlite"), { timeout: 5000 });
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
sqlite.exec(await readFile(new URL("./drizzle/0000_watchlist.sql", import.meta.url), "utf8"));
sqlite.exec("CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

const DB = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
    const use = (...values) => ({
      first: async () => stmt.get(...values) ?? null,
      all: async () => ({ results: stmt.all(...values) }),
      run: () => ({ meta: { changes: Number(stmt.run(...values).changes) } }),
    });
    return { ...use(), bind: use };
  },
  async batch(statements) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(stmt => stmt.run());
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};

async function loadPushKeys() {
  const stored = sqlite.prepare("SELECT value FROM server_settings WHERE key = 'vapid'").get();
  if (stored) return JSON.parse(stored.value);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const credentials = {
    VAPID_PRIVATE: JSON.stringify(await crypto.subtle.exportKey("jwk", keys.privateKey)),
    VAPID_PUBLIC: Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url"),
  };
  sqlite.prepare("INSERT OR IGNORE INTO server_settings VALUES ('vapid', ?)").run(JSON.stringify(credentials));
  return JSON.parse(sqlite.prepare("SELECT value FROM server_settings WHERE key = 'vapid'").get().value);
}

const workerEnv = {
  DB,
  PUBLIC_ORIGIN: publicOrigin,
  ALERT_INTERVAL_MINUTES: interval,
  ...(await loadPushKeys()),
};

const cookieName = "__Host-hyper-session";
const lifetime = 30 * 86400;
const headerSecurity = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'",
};

const headersNoCache = { ...headerSecurity, "Cache-Control": "no-store" };
const allowPublicAssets = new Set(["/styles.css", "/login.css", "/icon.svg", "/icon.png", "/manifest.webmanifest", "/icon-512.png"]);

function signature(data) {
  return createHmac("sha256", sessionKey).update(configuredHash).update(".").update(data).digest("base64url");
}

function cookie(value, age) {
  return `${cookieName}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function newSession() {
  const expires = Math.floor(Date.now() / 1000) + lifetime;
  const value = `${expires}.${randomBytes(18).toString("base64url")}`;
  return cookie(value + "." + signature(value), lifetime);
}

function hasSession(header = "") {
  const token = header.split(";").map(part => part.trim()).find(part => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  if (!token || !/^\d{10,13}\.[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const [expires, nonce, proof] = token.split(".");
  if (Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  return timingSafeEqual(Buffer.from(proof), Buffer.from(signature(expires + "." + nonce)));
}

const failures = new Map();
const derive = promisify(scrypt);

function loginPage(error = "") {
  const notice = error ? '<div class="notice" role="alert">' + error + "</div>" : "";
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#101219"><title>登录 · Hyper 盯盘</title><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/icon.png"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/login.css"></head>
<body><main class="login-frame"><section class="login-panel" aria-labelledby="title">
<a class="brand" href="/"><img class="brand-mark" src="/icon.svg" alt="" width="36" height="36"><span>Hyper <b>盯盘</b></span></a>
<h1 id="title">登录私人看板</h1><p>使用部署时设置的密码登录。</p>${notice}
<form action="/login" method="post"><label for="password">看板密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
<button class="btn primary-btn" type="submit">登录</button></form></section></main></body></html>`;
}

function send(outgoing, status, text, headers = {}) {
  outgoing.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headersNoCache, ...headers });
  outgoing.end(text);
}

function redirect(outgoing, location, setCookie) {
  send(outgoing, 303, "", { Location: location, ...(setCookie ? { "Set-Cookie": setCookie } : {}) });
}

function fromOwnPage(incoming) {
  return (!incoming.headers.origin || incoming.headers.origin === publicOrigin) && !["cross-site", "same-site"].includes(incoming.headers["sec-fetch-site"]);
}

async function login(incoming, outgoing) {
  const contentType = incoming.headers["content-type"] || "";
  if (!fromOwnPage(incoming)) return send(outgoing, 403, "请求来源无效");
  if (!contentType.startsWith("application/x-www-form-urlencoded")) return send(outgoing, 415, "请求格式无效");
  const forwarded = String(incoming.headers["x-real-ip"] || "");
  const key = isIP(forwarded) ? forwarded : incoming.socket.remoteAddress || "unknown";
  const now = Date.now();
  for (const [ip, state] of failures) if (state.until <= now) failures.delete(ip);
  const current = failures.get(key);
  if (current?.count >= 8) return send(outgoing, 429, loginPage("尝试次数过多，请稍后再试。"), { "Content-Type": "text/html; charset=utf-8" });
  if (failures.size >= 2000 && !current) return send(outgoing, 429, "请稍后再试");

  failures.set(key, { count: (current?.count || 0) + 1, until: current?.until ?? now + 15 * 60000 });
  let size = 0;
  const chunks = [];
  for await (const buffer of incoming) {
    size += buffer.length;
    if (size > 4096) return send(outgoing, 413, "请求内容太长");
    chunks.push(buffer);
  }
  const password = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("password") ?? "";
  const valid = password.length <= 256 && timingSafeEqual(await derive(password, salt, 48), expectedHash);
  if (!valid) return send(outgoing, 401, loginPage("密码不正确。"), { "Content-Type": "text/html; charset=utf-8" });
  failures.delete(key);
  redirect(outgoing, "/", newSession());
}

const server = createServer({ requestTimeout: 15000, headersTimeout: 7000 }, async (incoming, outgoing) => {
  try {
    if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) return send(outgoing, 400, "无效路径");
    const url = new URL(incoming.url, publicOrigin);
    if (url.origin !== publicOrigin) return send(outgoing, 400, "无效路径");
    const path = url.pathname;
    if (path === "/healthz" && incoming.method === "GET") return send(outgoing, 200, "ok");
    if (String(incoming.headers.host ?? "").toLowerCase() !== publicUrl.host) return send(outgoing, 421, "请使用配置的域名访问");
    const signedIn = hasSession(incoming.headers.cookie);
    if (path === "/login" && incoming.method === "GET") {
      if (signedIn) return redirect(outgoing, "/");
      return send(outgoing, 200, loginPage(), { "Content-Type": "text/html; charset=utf-8" });
    }
    if (path === "/login" && incoming.method === "POST") return await login(incoming, outgoing);
    if (path === "/logout" && incoming.method === "POST" && signedIn) {
      return fromOwnPage(incoming) ? redirect(outgoing, "/login", cookie("", 0)) : send(outgoing, 403, "请求来源无效");
    }
    if (!signedIn && !allowPublicAssets.has(path)) {
      if (path.startsWith("/api/")) return send(outgoing, 401, JSON.stringify({ error: "请登录看板" }), { "Content-Type": "application/json" });
      if (path === "/sw.js") return send(outgoing, 401, "请登录看板");
      return redirect(outgoing, "/login");
    }

    const headers = new Headers(incoming.headers);
    headers.delete("oai-authenticated-user-id");
    if (signedIn) headers.set("oai-authenticated-user-id", "owner");
    const streamBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const request = new Request(url, {
      method: incoming.method,
      headers,
      ...(streamBody ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
    });
    const response = await worker.fetch(request, workerEnv);
    outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), ...headerSecurity });
    if (!response.body) return outgoing.end();
    Readable.fromWeb(response.body).on("error", () => outgoing.destroy()).pipe(outgoing);
  } catch {
    if (outgoing.headersSent) return outgoing.destroy();
    send(outgoing, 503, "看板暂时不可用");
  }
});

let inProgress = false;
async function scheduledScan() {
  if (inProgress) return;
  inProgress = true;
  try {
    const outcome = await checkAlerts(workerEnv);
    if (outcome.failures) console.warn("Hyperliquid 读取失败数", outcome.failures);
  } catch {
    console.warn("后台提醒检查暂时失败，下次自动重试。");
  } finally {
    inProgress = false;
  }
}

const port = Number(process.env.PORT || 8788);
server.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log("Hyper 盯盘已启动，监听端口", port);
  setTimeout(scheduledScan, 3000).unref();
  setInterval(scheduledScan, interval * 60000).unref();
});
