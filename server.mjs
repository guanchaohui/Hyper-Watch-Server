import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import worker from "./dist/server/index.js";
import version from "./dist/server/version.js";
import { checkAlerts } from "./dist/server/alerts.js";
import { startFillStream } from "./dist/server/fill-stream.js";
import { startEquitySync, startLedgerSync } from "./dist/server/ledger-sync.js";
import { startOrderStreams } from "./dist/server/order-stream.js";

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
if (!sqlite.prepare("PRAGMA table_info(alerts)").all().some(column => column.name === "title")) {
  sqlite.exec("ALTER TABLE alerts ADD COLUMN title TEXT");
}
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );
`);
const receiptsMigration = await readFile(new URL("./drizzle/0001_alert_receipts.sql", import.meta.url), "utf8");
const tradeMigration = await readFile(new URL("./drizzle/0002_trade_alert_buffer.sql", import.meta.url), "utf8");
const historyMigration = await readFile(new URL("./drizzle/0003_wallet_history.sql", import.meta.url), "utf8");
const detailMigration = await readFile(new URL("./drizzle/0004_alert_details.sql", import.meta.url), "utf8");
sqlite.exec("BEGIN IMMEDIATE");
try {
  const schemaVersion = sqlite.prepare("PRAGMA user_version").get().user_version;
  if (schemaVersion < 1) sqlite.exec(receiptsMigration);
  if (schemaVersion < 2) sqlite.exec(tradeMigration);
  if (schemaVersion < 3) sqlite.exec(historyMigration);
  if (schemaVersion < 4) {
    sqlite.exec(detailMigration);
    sqlite.exec("PRAGMA user_version = 4");
  }
  sqlite.exec("COMMIT");
} catch (error) {
  sqlite.exec("ROLLBACK");
  throw error;
}

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
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'",
};

const headersNoCache = { ...headerSecurity, "Cache-Control": "no-store" };
const allowPublicAssets = new Set(["/styles.css", "/login.css", "/icon.svg", "/icon.png", "/manifest.webmanifest", "/icon-512.png", "/version-check.js"]);

function signature(data) {
  return createHmac("sha256", sessionKey).update(configuredHash).update(".").update(data).digest("base64url");
}

function cookie(value, age) {
  return `${cookieName}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function newSession(username) {
  const expires = Math.floor(Date.now() / 1000) + lifetime;
  const value = `${username}.${expires}.${randomBytes(18).toString("base64url")}`;
  return cookie(value + "." + signature(value), lifetime);
}

const usernamePattern = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const owner = "owner";

function sessionAccount(header = "") {
  const token = header.split(";").map(part => part.trim()).find(part => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  const match = token?.match(/^([a-z0-9_-]{3,24})\.(\d{10,13})\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const [, username, expires, nonce, proof] = match;
  if (!usernamePattern.test(username) || Number(expires) <= Math.floor(Date.now() / 1000)) return null;
  const expected = signature([username, expires, nonce].join("."));
  if (!timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) return null;
  return username;
}

const loginAttempts = new Map();
const registrationAttempts = new Map();
const derive = promisify(scrypt);

function accountPage(title, content) {
  return `<!doctype html>
<html lang="zh-CN" data-version="${version}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#101219"><title>${title} · Hyper 盯盘</title><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/icon.png"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/login.css"><script src="/version-check.js" defer></script></head>
<body><div class="version-notice" id="version-notice" hidden><span role="status">有新版本</span><button class="btn" id="version-reload" type="button">刷新</button></div><main class="login-frame"><section class="login-panel" aria-labelledby="title">
<a class="brand" href="/"><img class="brand-mark" src="/icon.svg" alt="" width="36" height="36"><span>Hyper <b>盯盘</b></span></a>
<h1 id="title">${title}</h1>${content}</section></main></body></html>`;
}

function credentialsPage(register, error = "") {
  const notice = error ? '<div class="notice" role="alert">' + error + "</div>" : "";
  const title = register ? "创建看板账户" : "登录私人看板";
  const hint = register ? "" : "登录后可在手机和电脑上同步你的钱包。";
  const alternate = register ? '<a href="/login">返回登录</a>' : '<a href="/register">注册账户</a>';
  return accountPage(title, `${hint ? "<p>" + hint + "</p>" : ""}${notice}
<form action="/${register ? "register" : "login"}" method="post">
<label for="username">用户名</label>
<input id="username" name="username" required minlength="3" maxlength="24" autocomplete="username" autocapitalize="none" spellcheck="false"${register ? ' pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{2,23}" aria-describedby="username-help"' : ""}>
${register ? '<small id="username-help">3–24 个字符，可用字母、数字、下划线或连字符。</small>' : ""}
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" required maxlength="256"${register ? ' minlength="7" aria-describedby="password-help"' : ""}>
${register ? '<small id="password-help">至少 7 个字符。</small>' : ""}
<button class="btn primary-btn" type="submit">${register ? "注册并登录" : "登录"}</button>
</form><div class="account-links">${alternate}</div>`);
}

function accountSettings(username) {
  return accountPage("账户", `<p>已登录为 <strong>${username}</strong></p>
<form method="post" action="/logout"><button class="btn" type="submit">退出登录</button></form>
<div class="account-links"><a href="/">返回看板</a></div>`);
}

const html = (outgoing, text, status = 200) => send(outgoing, status, text, { "Content-Type": "text/html; charset=utf-8" });

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

async function registerAccount(username, password) {
  const accountSalt = randomBytes(24).toString("base64url");
  const hash = (await derive(password, accountSalt, 48)).toString("base64url");
  return sqlite.prepare("INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(username) DO NOTHING")
    .run(username, accountSalt, hash).changes === 1;
}

async function authenticate(incoming, outgoing, register) {
  const contentType = incoming.headers["content-type"] || "";
  if (!fromOwnPage(incoming)) return send(outgoing, 403, "请求来源无效");
  if (!contentType.startsWith("application/x-www-form-urlencoded")) return send(outgoing, 415, "请求格式无效");
  const forwarded = String(incoming.headers["x-real-ip"] || "");
  const key = isIP(forwarded) ? forwarded : incoming.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempts = register ? registrationAttempts : loginAttempts;
  for (const [ip, state] of attempts) if (state.until <= now) attempts.delete(ip);
  const current = attempts.get(key);
  if (current?.count >= 8 || (attempts.size >= 2000 && !current)) {
    return html(outgoing, credentialsPage(register, "尝试次数过多，请稍后再试。"), 429);
  }
  attempts.set(key, { count: (current?.count || 0) + 1, until: current?.until ?? now + 15 * 60000 });

  let size = 0;
  const chunks = [];
  for await (const buffer of incoming) {
    size += buffer.length;
    if (size > 4096) return send(outgoing, 413, "请求内容太长");
    chunks.push(buffer);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const username = (form.get("username") ?? "").trim().toLowerCase();
  const password = form.get("password") ?? "";
  if (register) {
    if (!usernamePattern.test(username) || username === owner || password.length < 7 || password.length > 256 || password.includes("\0")) {
      return html(outgoing, credentialsPage(true, "请使用可用的用户名和 7–256 个字符的密码。"), 400);
    }
    if (!await registerAccount(username, password)) {
      return html(outgoing, credentialsPage(true, "用户名已被使用，请换一个。"), 409);
    }
  } else {
    const account = username === owner ? { salt, password_hash: configuredHash }
      : sqlite.prepare("SELECT salt, password_hash FROM accounts WHERE username = ?").get(username);
    const expected = account ? Buffer.from(account.password_hash, "base64url") : expectedHash;
    const valid = password.length <= 256 && timingSafeEqual(await derive(password, account?.salt ?? salt, 48), expected);
    if (!account || !valid) return html(outgoing, credentialsPage(false, "用户名或密码不正确。"), 401);
    attempts.delete(key);
  }
  redirect(outgoing, "/", newSession(username));
}

const server = createServer({ requestTimeout: 15000, headersTimeout: 7000 }, async (incoming, outgoing) => {
  try {
    if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) return send(outgoing, 400, "无效路径");
    const url = new URL(incoming.url, publicOrigin);
    if (url.origin !== publicOrigin) return send(outgoing, 400, "无效路径");
    const path = url.pathname;
    if (path === "/healthz" && incoming.method === "GET") return send(outgoing, 200, "ok");
    if (String(incoming.headers.host ?? "").toLowerCase() !== publicUrl.host) return send(outgoing, 421, "请使用配置的域名访问");
    if (path === "/version.json" && incoming.method === "GET") {
      return send(outgoing, 200, JSON.stringify({ version }), { "Content-Type": "application/json" });
    }
    const signedIn = sessionAccount(incoming.headers.cookie);
    if (path === "/login" || path === "/register") {
      if (signedIn) return redirect(outgoing, "/");
      const register = path === "/register";
      if (incoming.method === "GET") return html(outgoing, credentialsPage(register));
      if (incoming.method === "POST") return await authenticate(incoming, outgoing, register);
      return send(outgoing, 405, "请求方法不可用");
    }
    if (path === "/logout" && incoming.method === "POST" && signedIn) {
      return fromOwnPage(incoming) ? redirect(outgoing, "/login", cookie("", 0)) : send(outgoing, 403, "请求来源无效");
    }
    if (path === "/account" && incoming.method === "GET" && signedIn) {
      return html(outgoing, accountSettings(signedIn));
    }
    if (path === "/api/account" && incoming.method === "GET" && signedIn) {
      return send(outgoing, 200, JSON.stringify({ username: signedIn }), { "Content-Type": "application/json" });
    }
    if (!signedIn && !allowPublicAssets.has(path)) {
      if (path.startsWith("/api/")) return send(outgoing, 401, JSON.stringify({ error: "请登录看板" }), { "Content-Type": "application/json" });
      if (path === "/sw.js") return send(outgoing, 401, "请登录看板");
      return redirect(outgoing, "/login");
    }

    const headers = new Headers(incoming.headers);
    headers.delete("oai-authenticated-user-id");
    if (signedIn) headers.set("oai-authenticated-user-id", signedIn);
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
  const stopFillStream = startFillStream(workerEnv);
  server.once("close", stopFillStream);
  server.once("close", startLedgerSync(DB));
  server.once("close", startEquitySync(DB));
  server.once("close", startOrderStreams(DB));
  setTimeout(scheduledScan, 3000).unref();
  setInterval(scheduledScan, interval * 60000).unref();
});
