import { createChart } from "./chart.js";
import { setupWorkspace } from "./workspace.js";
import { addressOf, connectPerps, demoData, info, parsePortfolio, parsePositions, parseSpot } from "./market.js";

const $ = id => document.getElementById(id);
const icons = {
  wallet: '<path d="M4 6h14a2 2 0 0 1 2 2v2m0 5v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a3 3 0 0 1 3-3h11"/><path d="M22 10h-5a2.5 2.5 0 0 0 0 5h5z"/><path d="M17.5 12.5h.01"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M20 8a8 8 0 0 0-13.4-3.5L4 7m0-4v4h4m-4 9a8 8 0 0 0 13.4 3.5L20 17m0 4v-4h-4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  trend: '<path d="m3 17 6-6 4 4 7-8m-5 0h5v5"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeOff: '<path d="m3 3 18 18M10.5 6.1a10 10 0 0 1 1.5-.1c6.5 0 10 6 10 6a16 16 0 0 1-2.9 3.3M6.3 7.2A16 16 0 0 0 2 12s3.5 6 10 6a9 9 0 0 0 4.8-1.4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
};

function setIcon(node, name) {
  node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">' + icons[name] + "</svg>";
}
for (const node of document.querySelectorAll("[data-icon]")) setIcon(node, node.dataset.icon);

const cash = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const tinyCash = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 8 });
const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
const time = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const preferenceBase = "hyper-watch:";
const pollEvery = 20000;
const mask = "••••••";
const drawChart = createChart($("chart"), $("chart-empty"), $("chart-tooltip"), $("tooltip-time"), $("tooltip-value"));

function loadPreference(key, fallback) {
  try { return JSON.parse(localStorage.getItem(preferenceBase + key)) ?? fallback; }
  catch { return fallback; }
}

function savePreference(key, value) {
  try { localStorage.setItem(preferenceBase + key, JSON.stringify(value)); } catch {}
}

let masked = loadPreference("private", false) === true;
let recents = loadPreference("recent", []);
recents = Array.isArray(recents) ? recents.map(addressOf).filter(Boolean).slice(0, 4) : [];
let period = "day";
let series = "equity";
let tab = "positions";
let session;
let workspace;

function amount(number, options = {}) {
  if (number === null || number === undefined) return "—";
  if (masked) return mask;
  const plus = options.signed && number > 0 ? "+" : "";
  const format = options.compact && Math.abs(number) >= 10000 ? compact
    : Math.abs(number) > 0 && Math.abs(number) < .01 ? tinyCash : cash;
  return plus + format.format(number);
}

function quantity(number) {
  if (number === null || number === undefined) return "—";
  return masked ? mask : qty.format(number);
}

function percent(value, signed = false) {
  if (!Number.isFinite(value)) return "—";
  if (masked) return "•••";
  return (signed && value > 0 ? "+" : "") + value.toFixed(signed ? 2 : 0) + "%";
}

function tone(number) {
  return masked || !number ? "" : number > 0 ? "positive" : "negative";
}

function setNumber(id, number, options = {}) {
  const node = $(id);
  node.textContent = amount(number, options);
  const color = options.signed ? tone(number) : "";
  node.classList.toggle("positive", color === "positive");
  node.classList.toggle("negative", color === "negative");
}

function shortAddress(address) {
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function live(s) {
  return s.streamAt > 0 && Date.now() - s.streamAt < 38000;
}

function syncLayout() {
  const label = session.user ? shortAddress(session.user) : "添加钱包";
  $("wallet-label").textContent = label;
  $("wallet-caret").hidden = !session.user;
  $("wallet-button").setAttribute("aria-label", session.user ? "更换钱包 " + label : "添加钱包");
  const privacyLabel = masked ? "显示金额" : "隐藏金额";
  $("privacy").setAttribute("aria-label", privacyLabel);
  $("privacy").setAttribute("aria-pressed", String(masked));
  $("privacy").title = privacyLabel;
  setIcon($("privacy-icon"), masked ? "eyeOff" : "eye");
}

function renderConnection() {
  const s = session;
  const failed = Boolean(s.errors.size);
  const loading = s.requesting && !s.requestedAt;
  const streamLive = live(s);
  const status = !s.user ? "demo" : failed ? "error" : loading ? "loading" : streamLive ? "live" : "poll";
  const statusNames = { demo: "演示数据", error: "更新异常", loading: "正在连接", live: "合约实时", poll: "定时刷新" };
  $("status").dataset.state = status;
  if ($("status-label").textContent !== statusNames[status]) $("status-label").textContent = statusNames[status];
  $("refresh").disabled = s.requesting;
  $("refresh").classList.toggle("is-spinning", s.requesting);
  $("notice").hidden = !failed;
  const errors = [...s.errors].filter(key => key !== "positions" || !streamLive);
  const errorNames = { history: "账户权益", spot: "现货余额", positions: "合约持仓" };
  $("notice-text").textContent = errors.length
    ? `${errors.map(key => errorNames[key]).join("、")}暂时无法更新。已获取的数据会继续显示。` : "";
  $("notice").hidden = !errors.length;
  if ($("details-dialog").open) renderDiagnostics();
  const freshness = !s.user ? "当前为演示数据" : s.requestedAt ? "API 最近刷新 " + clock.format(s.requestedAt) : "等待 Hyperliquid 返回数据";
  $("footer-update").textContent = freshness;
  const holdingInfo = !s.user ? (tab === "positions" ? "演示持仓" : "演示余额") :
    tab === "spot" ? (s.errors.has("spot") ? "更新异常" : s.spot ? "定时刷新" : "等待余额") :
    streamLive ? "实时更新" : s.errors.has("positions") ? "更新异常" : s.positions ? (s.scope === "all" ? "上次快照" : "主市场快照") : "等待持仓";
  $("holding-info").dataset.stream = tab === "positions" && streamLive ? "live" : "";
  $("holding-info-text").textContent = holdingInfo;
}

function renderMetrics() {
  const s = session;
  const day = s.history?.day;
  const equity = day?.equity?.length ? day.equity : (s.history?.allTime?.equity ?? []);
  const last = equity.at(-1);
  const daily = day?.pnl.length > 1 ? day.pnl.at(-1)[1] - day.pnl[0][1] : null;
  const first = day?.equity[0]?.[1];
  const pos = s.positions;
  const unrealized = pos && pos.every(row => row.pnl !== null) ? pos.reduce((sum, row) => sum + row.pnl, 0) : null;
  setNumber("equity", last?.[1]);
  setNumber("daily", daily, { signed: true });
  setNumber("floating", unrealized, { signed: true });
  const change = $("daily-percent");
  const relative = daily !== null && first > 0 && !masked ? daily / first * 100 : null;
  change.hidden = !Number.isFinite(relative);
  change.textContent = percent(relative, true);
  change.className = "change " + tone(relative);
  $("daily-note").textContent = change.hidden ? "按官方盈亏曲线计算" : "相对期初权益";
  $("equity-note").textContent = s.user && last ? "样本时间 " + time.format(last[0]) : "Hyperliquid 账户估值";
  $("floating-note").textContent = s.user && s.scope === "main" ? "主市场合约持仓" : "当前合约持仓的浮动盈亏";
}

function renderExposure() {
  $("exposure-unit").textContent = session.scope === "main" ? "主市场 · 名义价值" : "按名义价值";
  const pos = session.positions;
  const hasValues = pos && pos.every(item => item.value !== null);
  const long = hasValues ? pos.reduce((sum, item) => item.size > 0 ? sum + item.value : sum, 0) : null;
  const short = hasValues ? pos.reduce((sum, item) => item.size < 0 ? sum + item.value : sum, 0) : null;
  const total = hasValues ? long + short : null;
  const split = total > 0 ? long / total * 100 : null;
  $("ring").style.setProperty("--ring", split === null ? "#2a3140" :
    `conic-gradient(var(--green) 0% ${split}%, var(--short) ${split}% 100%)`);
  setNumber("exposure-total", total, { compact: true });
  setNumber("exposure-long", long);
  setNumber("exposure-short", short);
  $("long-percent").textContent = percent(split);
  $("short-percent").textContent = percent(split === null ? null : 100 - split);
}

function renderChart() {
  const s = session;
  const points = s.history?.[period]?.[series] ?? [];
  const emptyText = s.errors.has("history") ? "暂时无法读取账户历史" :
    s.history ? "该时段暂无历史数据" : "正在读取账户历史…";
  drawChart({ points, series, period, masked, emptyText });
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

const coinGlyph = { BTC: "₿", ETH: "◆", SOL: "≋", HYPE: "H", USDC: "$" };

function coinCell(coin, dex = "") {
  const base = coin.split(":").at(-1);
  const node = element("span", "coin");
  const icon = element("span", "coin-icon", Object.hasOwn(coinGlyph, base) ? coinGlyph[base] : base.slice(0, 1));
  icon.dataset.coin = base;
  icon.setAttribute("aria-hidden", "true");
  const text = element("span");
  text.append(element("strong", "", base));
  if (dex) text.append(element("small", "", dex));
  node.append(icon, text);
  return node;
}

function sideCell(row) {
  const side = element("span");
  const short = row.size < 0;
  side.append(element("span", "direction" + (short ? " short" : ""), short ? "空仓" : "多仓"));
  if (row.leverage) side.append(element("span", "lev", row.leverage + "×"));
  return side;
}

function renderHoldings() {
  const s = session;
  $("position-count").textContent = s.positions?.length ?? "—";
  $("spot-count").textContent = s.spot?.length ?? "—";
  const body = $("holdings-body");
  const spot = tab === "spot";
  const list = spot ? s.spot : s.positions;

  if (!list?.length) {
    const type = spot ? "现货余额" : "合约持仓";
    const missing = s.errors.has(tab);
    const message = missing ? type + "暂时无法更新" :
      list ? "当前暂无" + (!spot && s.scope === "main" ? "主市场" : "") + type : "正在读取" + type + "…";
    body.replaceChildren(element("div", "empty-holdings", message));
    return;
  }

  const columns = spot
    ? ["资产", "总数量", "占用数量"]
    : ["合约", "方向", "持仓数量", "开仓价", "标记价", "未实现盈亏"];
  const table = element("table", "holdings-table");
  const heading = table.createTHead().insertRow();
  for (const label of columns) {
    const th = element("th", "", label);
    th.scope = "col";
    heading.append(th);
  }

  const rows = table.createTBody();
  const mobile = element("div", "mobile-holdings");
  for (const row of list) {
    const fieldValues = spot
      ? [quantity(row.total), quantity(row.hold)]
      : [quantity(Math.abs(row.size)), amount(row.entry), amount(row.mark), amount(row.pnl, { signed: true })];

    const tr = rows.insertRow();
    tr.insertCell().append(coinCell(row.coin, row.dex));
    if (!spot) tr.insertCell().append(sideCell(row));
    fieldValues.forEach((value, index) => {
      const td = tr.insertCell();
      td.textContent = value;
      if (!spot && index === 3) td.className = tone(row.pnl);
    });

    const card = element("article", "mobile-holding" + (spot ? " spot" : ""));
    const top = element("div", "mobile-holding-top");
    top.append(coinCell(row.coin, row.dex));
    if (!spot) top.append(sideCell(row));
    const fields = element("dl");
    fieldValues.forEach((value, index) => {
      const field = element("div", "mobile-field");
      field.append(element("dt", "", columns[index + (spot ? 1 : 2)]),
        element("dd", !spot && index === 3 ? tone(row.pnl) : "", value));
      fields.append(field);
    });
    card.append(top, fields);
    mobile.append(card);
  }
  body.replaceChildren(table, mobile);
}

function renderAll() {
  syncLayout();
  renderMetrics();
  renderExposure();
  renderChart();
  renderHoldings();
  renderConnection();
  workspace?.onSnapshot();
}

function renderPositions() {
  renderMetrics();
  renderExposure();
  renderHoldings();
  renderConnection();
  workspace?.onSnapshot();
}

async function refresh(s = session) {
  if (!s.user || s.requesting || session !== s) return;
  s.requesting = true;
  renderConnection();

  const requests = [
    ["history", "portfolio", parsePortfolio],
    ["spot", "spotClearinghouseState", parseSpot],
  ];
  if (!live(s)) requests.push(["positions", "clearinghouseState", raw => parsePositions([["", raw]])]);

  await Promise.all(requests.map(async ([key, endpoint, parse]) => {
    try {
      const raw = await info(endpoint, s.user, s.controller.signal);
      if (session !== s || (key === "positions" && live(s))) return;
      s[key] = parse(raw);
      if (key === "positions") s.scope = "main";
      s.requestedAt = Date.now();
      s.times.set(key, s.requestedAt);
      s.problems.delete(key);
      s.errors.delete(key);
    } catch (error) {
      if (session !== s || (key === "positions" && live(s))) return;
      s.errors.add(key);
      s.problems.set(key, error);
    }
  }));
  if (session !== s) return;
  s.requesting = false;
  renderAll();
}

function openAccount(user) {
  if (session) {
    session.controller.abort();
    session.disconnect?.();
  }
  const s = {
    user, controller: new AbortController(), errors: new Set(),
    history: null, positions: null, spot: null, requestedAt: 0, requesting: false,
    disconnect: null, streamAt: 0, scope: "", times: new Map(), problems: new Map(),
  };
  session = s;
  if (user) {
    s.disconnect = connectPerps(user, positions => {
      if (session !== s) return;
      s.positions = positions;
      s.scope = "all";
      s.streamAt = Date.now();
      s.times.set("positions", s.streamAt);
      s.problems.delete("positions");
      s.errors.delete("positions");
      renderPositions();
    }, () => {
      if (session !== s) return;
      s.streamAt = 0;
      renderConnection();
      if (!document.hidden && !s.requesting && s.requestedAt) refresh(s);
    });
  } else {
    Object.assign(s, demoData());
  }
  savePreference("wallet", user);
  renderAll();
  if (user) refresh(s);
}

function registerChoice(group, prop, update) {
  $(group).addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button?.dataset[prop]) return;
    for (const other of $(group).querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === button));
    update(button.dataset[prop]);
  });
}

registerChoice("periods", "period", value => { period = value; renderChart(); });
registerChoice("series", "series", value => { series = value; renderChart(); });
registerChoice("holdings-tabs", "tab", value => { tab = value; renderHoldings(); renderConnection(); });

const dialog = $("wallet-dialog");
const input = $("wallet-input");
const message = $("address-message");
const defaultMessage = message.textContent;

function reportAddressError(invalid) {
  input.setAttribute("aria-invalid", String(invalid));
  message.classList.toggle("error", invalid);
  message.textContent = invalid ? "请输入以 0x 开头、共 42 个字符的公开钱包地址。" : defaultMessage;
}

function renderRecents() {
  $("recents").hidden = recents.length === 0;
  const buttons = recents.map(user => {
    const button = element("button", "btn recent", shortAddress(user));
    button.type = "button";
    button.setAttribute("aria-label", `观察地址 ${user}`);
    button.title = user;
    button.append(element("small", "", user === session.user ? "当前钱包" : "切换"));
    button.addEventListener("click", () => selectAddress(user));
    return button;
  });
  $("recents-list").replaceChildren(...buttons);
}

function selectAddress(user) {
  if (user) {
    recents = [user, ...recents.filter(recent => recent !== user)].slice(0, 4);
    savePreference("recent", recents);
  }
  dialog.close();
  if (user !== session.user) openAccount(user);
  else if (user && session.errors.size) refresh();
}

$("wallet-button").addEventListener("click", () => {
  input.value = session.user;
  reportAddressError(false);
  renderRecents();
  dialog.showModal();
  if (session.user) input.select();
});
$("close-wallet").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
$("demo-button").addEventListener("click", () => selectAddress(""));
$("clear-recents").addEventListener("click", () => {
  recents = [];
  savePreference("recent", recents);
  renderRecents();
  input.focus();
});
function observeWallet() {
  const user = addressOf(input.value);
  if (user) selectAddress(user);
  else { reportAddressError(true); input.focus(); }
}

$("observe-wallet").addEventListener("click", observeWallet);
input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    observeWallet();
  }
});
input.addEventListener("input", () => reportAddressError(false));
$("privacy").addEventListener("click", () => {
  masked = !masked;
  savePreference("private", masked);
  renderAll();
});
$("refresh").addEventListener("click", () => {
  if (session.user) refresh();
  else { Object.assign(session, demoData()); renderAll(); }
});
$("retry").addEventListener("click", () => refresh());

function connectionMessage(error) {
  if (!error) return "";
  if (error.status === 429) return "接口限流，稍后再试";
  if (error.status === 504 || error.timeout) return "接口请求超时";
  if (error.status) return "接口返回 HTTP " + error.status;
  if (error instanceof TypeError) return "当前页面无法连接数据接口";
  return "接口未返回可读取的数据";
}

function renderDiagnostics() {
  const s = session;
  const content = $("details-content");
  if (!s.user) {
    content.replaceChildren(element("p", "hint", "当前为演示数据。添加公开钱包后可检查三类接口。"));
    return;
  }
  const list = element("ul", "diagnostics-list");
  const names = [["history", "权益历史"], ["spot", "现货余额"], ["positions", "合约仓位"]];
  for (const [key, name] of names) {
    const row = element("li");
    const requestTime = s.times.get(key);
    const error = connectionMessage(s.problems.get(key));
    const status = error || (!requestTime ? "等待返回" : s.requesting ? "正在更新" : "最近一次读取成功");
    row.append(element("strong", "", name + " · " + status),
      element("small", "", requestTime ? "最后成功 " + time.format(requestTime) : "暂无成功时间"));
    list.append(row);
  }
  const transport = live(s) ? "实时仓位推送在线" : "仓位使用定时快照";
  content.replaceChildren(list, element("p", "hint", transport));
}

$("diagnostics").addEventListener("click", () => {
  renderDiagnostics();
  $("details-dialog").showModal();
});
$("close-details").addEventListener("click", () => $("details-dialog").close());

openAccount(addressOf(loadPreference("wallet", "")));
workspace = setupWorkspace({
  session: () => session,
  observe: openAccount,
  amount, quantity, percent, tone,
  load: loadPreference, store: savePreference,
});
setInterval(() => { if (!document.hidden) refresh(); }, pollEvery);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - session.requestedAt > 5000) refresh();
});
window.addEventListener("online", () => refresh());
