import { formatMoney } from "./format-values.js";
import { movedPositionOrder, orderPositions, positionKey, setupCardOrdering } from "./position-order.js";
import { createChart } from "./chart.js";
import { setupWorkspace } from "./workspace.js";
import { filterPositions, periodPnl, portfolioBrief, portfolioPeriodPoints, positionLeverage,
  positionTotals, todayGap, todayPortfolio, utc8DayStart } from "./analytics.js";
import { addressOf, connectPerps, demoData, info, parsePortfolio, parsePositions, parseSpot } from "./market.js";

const $ = id => document.getElementById(id);
const icons = {
  home: '<path d="m3 10 9-7 9 7m-2-2v12H5V8m5 12v-6h4v6"/>',
  records: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0v5l-2 3h16l-2-3V8m-8 11a2 2 0 0 0 4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
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

const qty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
const time = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const account = document.documentElement.dataset.account;
const preferenceBase = account && account !== "owner" ? "hyper-watch:account:" + account + ":" : "hyper-watch:";
if (account) {
  window.addEventListener("pageshow", event => {
    if (event.persisted) location.reload();
  });
}
const pollEvery = 5000;
const activityEvery = 60_000;
const positionStaleAfter = 45_000;
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
const pnlSummarySelect = $("pnl-summary-range");
const legacyRange = loadPreference("pnl-summary-range", null);
const savedPnlRange = loadPreference("overview-period", legacyRange === "day" ? "today" : legacyRange);
pnlSummarySelect.value = ["day", "week", "month", "allTime"].includes(savedPnlRange) ? savedPnlRange : "today";
const positionSort = $("position-sort");
const positionLayout = $("position-layout");
const cardMedia = matchMedia("(max-width: 780px), (display-mode: standalone) and (max-width: 980px)");
positionSort.value = loadPreference("position-sort", "notional");
if (!positionSort.value) positionSort.value = "notional";
positionLayout.value = loadPreference("position-layout", "auto");
let autoRefresh = loadPreference("auto-refresh", true) !== false;
let period = pnlSummarySelect.value;
let series = "equity";
let tab = "positions";
let session;

function amount(value, options) {
  const display = formatMoney(value, options);
  return masked && display !== "—" ? mask : display;
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
  $("mobile-privacy-label").textContent = privacyLabel;
  $("mobile-privacy").setAttribute("aria-pressed", String(masked));
  for (const id of ["privacy-icon", "mobile-privacy-icon"]) setIcon($(id), masked ? "eyeOff" : "eye");
}

function renderConnection() {
  const s = session;
  const failed = Boolean(s.errors.size);
  const loading = s.requesting && !s.requestedAt;
  const streamLive = live(s);
  const status = !s.user ? (s.demo ? "demo" : "idle") : !navigator.onLine ? "error" :
    failed ? "error" : loading ? "loading" : streamLive ? "live" : autoRefresh ? "poll" : "paused";
  const statusNames = { idle: "未选择钱包", demo: "演示数据", error: navigator.onLine ? "更新异常" : "网络离线",
    loading: "正在连接", live: "合约实时", poll: "定时刷新", paused: "定时刷新已暂停" };
  $("status").dataset.state = status;
  if ($("status-label").textContent !== statusNames[status]) $("status-label").textContent = statusNames[status];
  $("refresh").disabled = s.requesting;
  $("mobile-refresh").disabled = s.requesting || (!s.user && !s.demo);
  $("refresh").classList.toggle("is-spinning", s.requesting);
  $("notice").hidden = !failed;
  const errors = [...s.errors].filter(key => key !== "positions" || !streamLive);
  const errorNames = { history: "账户权益", spot: "现货余额", positions: "合约持仓" };
  $("notice-text").textContent = s.user && !navigator.onLine ? "网络离线，继续显示已获取的快照。" : errors.length
    ? `${errors.map(key => errorNames[key]).join("、")}暂时无法更新。已获取的数据会继续显示。` : "";
  $("notice").hidden = !errors.length && !(s.user && !navigator.onLine);
  $("retry").hidden = !navigator.onLine;
  if ($("details-dialog").open) renderDiagnostics();
  const freshness = !s.user ? (s.demo ? "当前为演示数据" : "请选择钱包") :
    s.requestedAt ? "API 最近成功 " + clock.format(s.requestedAt) : "等待 Hyperliquid 返回数据";
  $("footer-update").textContent = freshness;
  $("auto-refresh").hidden = !s.user;
  $("auto-refresh").textContent = autoRefresh ? "暂停定时刷新" : "恢复定时刷新";
  $("auto-refresh").setAttribute("aria-pressed", String(!autoRefresh));
  const holdingInfo = !s.user ? (s.demo ? (tab === "positions" ? "演示持仓" : "演示余额") : "未选择钱包") :
    tab === "spot" ? (s.errors.has("spot") ? "更新异常" : s.spot ? "定时刷新" : "等待余额") :
    streamLive ? "实时更新" : s.errors.has("positions") ? "更新异常" : s.positions ? (s.scope === "all" ? "上次快照" : "默认市场快照") : "等待持仓";
  $("holding-info").dataset.stream = tab === "positions" && streamLive ? "live" : "";
  const observed = s.times.get(tab);
  $("holding-info-text").textContent = observed ? holdingInfo + " · " + clock.format(observed) : holdingInfo;
  renderRiskCockpit();
}

const chinaClock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function todayData(s) {
  const now = Date.now();
  const midnight = utc8DayStart(now);
  const memo = s.todayMemo;
  if (memo?.history === s.history && memo.snapshots === s.equitySnapshots && memo.result.midnight === midnight) return memo.result;
  const result = todayPortfolio(s.history, s.equitySnapshots, now);
  s.todayMemo = { history: s.history, snapshots: s.equitySnapshots, result };
  return result;
}
const todayNote = result => {
  const { data, pnlStart, midnight } = result;
  const start = data?.start ?? pnlStart;
  if (start == null) return "等待今日盈亏样本（UTC+8）";
  if (start !== midnight) return "今日统计从 " + chinaClock.format(start) + " 开始（UTC+8）" + (data ? "" : " · 等待后续样本");
  return "00:00 UTC+8 起算" + (data?.estimated || data?.equityEstimated ? " · 估算" : "") + (data ? "" : " · 等待后续样本");
};

function renderMetrics() {
  const s = session;
  const day = s.history?.day;
  const equity = day?.equity?.length ? day.equity : (s.history?.allTime?.equity ?? []);
  const last = equity.at(-1);
  const range = pnlSummarySelect.value;
  const today = todayData(s);
  const summary = range === "today" ? today.data : periodPnl(s.history, range);
  const daily = summary?.pnl ?? null;
  const first = summary?.equity;
  const pos = s.positions;
  const unrealized = pos && pos.every(row => row.pnl !== null) ? pos.reduce((sum, row) => sum + row.pnl, 0) : null;
  setNumber("equity", last?.[1]);
  setNumber("daily", daily, { signed: true });
  setNumber("floating", unrealized, { signed: true });
  $("range-label").textContent = range === "today" ? "今日净盈亏" : "区间盈亏";
  $("today-pinned").hidden = range === "today";
  setNumber("today-net", today.data?.pnl ?? null, { signed: true });
  $("today-net-note").textContent = todayNote(today);
  renderRealized();
  const change = $("daily-percent");
  const relative = daily !== null && first > 0 && !masked ? daily / first * 100 : null;
  change.hidden = !Number.isFinite(relative);
  change.textContent = percent(relative, true);
  change.className = "change " + tone(relative);
  change.title = "区间盈亏金额 ÷ 期初账户权益";
  const note = $("daily-note");
  if (range === "today") note.textContent = todayNote(today);
  else if (summary) note.textContent = Number.isFinite(first) ? "期初权益 " + amount(first) : "缺少同期权益";
  else note.textContent = "等待区间盈亏样本";
  $("equity-note").textContent = s.user && last ? "样本时间 " + time.format(last[0]) : "Hyperliquid 账户估值";
  const observed = s.times.get("positions");
  const source = s.scope === "main" ? "默认市场" : "合约持仓";
  $("floating-note").textContent = observed ? source + " · " + clock.format(observed) : "当前合约持仓的浮动盈亏";
}

function renderRealized() {
  const { activity, activityError, demo, lastRealized } = session;
  const start = utc8DayStart();
  const today = activity?.todayStart === start ? activity : null;
  const known = lastRealized?.todayStart === start ? lastRealized : null;
  setNumber("realized-today", known?.realized ?? null, { signed: true });
  const status = today?.fillsState;
  const observed = known?.realizedAsOf ?? known?.asOf;
  $("realized-note").textContent = demo ? "演示模式" :
    known ? "合约成交 · 截至 " + chinaClock.format(observed) + "（UTC+8）" :
    status === "limited" ? "成交待补齐" : status === "incomplete" ? "成交数据不完整" :
    activityError || status === "unavailable" ? "等待成交同步" : "UTC+8 · 等待成交数据";
}

function renderRiskCockpit() {
  const s = session;
  const observed = s.times.get("positions");
  const fresh = s.demo || (navigator.onLine && observed && Date.now() - observed <= positionStaleAfter && !s.errors.has("positions"));
  $("risk-cockpit").dataset.asOf = observed ?? "";
  const { notional, margin } = positionTotals(s.positions);
  const source = s.demo ? "演示数据" : !s.positions ? (s.errors.has("positions") || !navigator.onLine ? "仓位暂不可用" : "等待仓位数据") :
    !fresh ? "仓位数据延迟 · 显示上次快照" : s.scope === "main" ?
      "仅默认市场 · " + clock.format(observed) : "全部永续市场 · " + clock.format(observed);
  $("risk-coverage").textContent = source;
  setNumber("risk-notional", notional);
  setNumber("risk-margin", margin);
  const totalLeverage = s.scope === "all" || s.demo ? leverage(notional, portfolioBrief(s.history).equity) : "—";
  for (const id of ["risk-leverage", "total-leverage"]) $(id).textContent = totalLeverage;
}

function renderRecentEvents() {
  const { activity, activityError, demo } = session;
  const list = $("account-event-list");
  const empty = $("account-events-empty");
  const complete = (activity?.tradeEventsState ?? activity?.fillsState) === "ready" && activity?.ledgerState === "ready";
  $("account-events-status").textContent = demo ? "演示模式" : activityError || !navigator.onLine ? "事件更新延迟" : activity ?
    "近 24 小时 · " + (complete ? "更新于 " + clock.format(activity.asOf) : "部分数据可用") : "等待账户事件";
  list.hidden = !activity?.events.length;
  empty.hidden = !list.hidden;
  empty.textContent = demo ? "切换到已保存的钱包查看活动。" : complete ? "近 24 小时暂无重要事件。" : "暂未读取到可展示的账户事件。";
  const labels = { open: "开仓", close: "平仓", reverse: "反手", deposit: "入金", withdraw: "出金",
    risk: "仓位风险提醒", equity: "权益提醒", leverage: "总杠杆提醒" };
  list.replaceChildren(...(activity?.events ?? []).map(event => {
    const item = element("li", "account-event");
    const label = event.coin ? event.coin + " · " + labels[event.type] + (event.side === "long" ? "多" : "空") : labels[event.type];
    const when = element("time", "", time.format(event.time));
    when.dateTime = new Date(event.time).toISOString();
    item.append(element("strong", "", label), when);
    if (Number.isFinite(event.amount)) {
      const movement = event.type === "deposit" || event.type === "withdraw";
      const value = amount(event.type === "withdraw" ? -event.amount : event.amount, { signed: movement });
      item.append(element("span", "account-event-amount", value));
    } else {
      const link = element("a", "quiet-link", "提醒记录");
      link.href = "/#alerts";
      item.append(link);
    }
    return item;
  }));
}

function renderExposure() {
  $("exposure-unit").textContent = session.scope === "main" ? "默认市场 · 名义价值" : "按名义价值";
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
  const today = period === "today" ? todayData(s) : null;
  const points = today ? today.points[series] : portfolioPeriodPoints(s.history, period, series);
  const start = series === "equity" ? today?.equityStart : today?.pnlStart;
  const hasGap = today && points.some(([at], index) => index > 0 && at - points[index - 1][0] > todayGap);
  const coverage = $("chart-coverage");
  coverage.hidden = !today || !points.length;
  if (!coverage.hidden) {
    const end = points.at(-1)[0];
    const duration = start === today.midnight ? "00:00 起算" : "从 " + chinaClock.format(start) + " 起";
    const estimated = series === "equity" ? today.equityEstimated : today.data?.estimated;
    coverage.textContent = duration + " · 截至 " + chinaClock.format(end) + "（UTC+8）" +
      (estimated ? " · 零点估算" : "") + (hasGap ? " · 采样缺口" : "");
  }
  const emptyText = today && series === "pnl" && today.pnlStart !== null ? todayNote(today) :
    s.errors.has("history") ? "暂时无法读取账户历史" : s.history ? "暂无此区间的历史样本" : "正在读取历史样本…";
  drawChart({ points, series, period, masked, emptyText, gap: today ? todayGap : Infinity });
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
  const side = element("span", "holding-side");
  const short = row.size < 0;
  side.append(element("span", "direction" + (short ? " short" : ""), short ? "空仓" : "多仓"));
  const mode = row.mode === "cross" ? "全仓" : row.mode === "isolated" ? "逐仓" : "";
  const detail = [row.leverage ? quantity(row.leverage) + "×" : "", mode].filter(Boolean).join(" ");
  if (detail) side.append(element("span", "lev", detail));
  return side;
}

function leverage(value, equity) {
  const ratio = positionLeverage(value, equity);
  return ratio === null ? "—" : masked ? mask : ratio.toFixed(2) + "×";
}

function holdingPrice(value) {
  return Number(value) > 0 ? amount(value) : "—";
}

function positionPnl(row) {
  const ratio = row.returnOnEquity ?? (row.margin > 0 && Number.isFinite(row.pnl) ? row.pnl / row.margin : null);
  const value = amount(row.pnl, { signed: true });
  const rate = percent(ratio === null ? null : ratio * 100, true);
  const pnl = element("span", "position-pnl " + tone(row.pnl));
  pnl.setAttribute("aria-label", "未实现盈亏 " + value + "，收益率 " + rate);
  pnl.append(element("span", "position-pnl-amount", value));
  if (ratio !== null && !masked) pnl.append(element("span", "position-pnl-rate", rate));
  return pnl;
}

function addHoldingField(fields, label, value) {
  const field = element("div", "mobile-field");
  field.append(element("dt", "", label), element("dd", "", value));
  fields.append(field);
}

const orderPreference = s => "position-order:" + (s.user || "demo");

function moveHolding(source, target, after) {
  const key = orderPreference(session);
  const saved = loadPreference(key, []);
  const sorted = filterPositions(session.positions ?? [], { sort: positionSort.value });
  const current = positionSort.value === "manual" ? orderPositions(sorted, saved) : sorted;
  const next = movedPositionOrder(current, saved, source, target, after);
  if (next) {
    savePreference(key, next);
    positionSort.value = "manual";
    savePreference("position-sort", "manual");
    const row = current.find(item => positionKey(item) === source);
    $("position-order-status").textContent = row.coin + " 已移到第 " + (next.indexOf(source) + 1) + " 位";
  }
  renderHoldings();
}

function holdingTable(columns, spot) {
  const table = element("table", spot ? "holdings-table" : "holdings-table contract-holdings");
  const heading = table.createTHead().insertRow();
  for (const label of columns) {
    const th = element("th", "", label);
    th.scope = "col";
    heading.append(th);
  }
  return table;
}

function appendHoldingRow(table, row, values, details) {
  const tr = table.insertRow();
  tr.insertCell().append(coinCell(row.coin, row.dex));
  if (details) tr.insertCell().append(sideCell(row));
  for (const value of values) tr.insertCell().textContent = value;
  if (!details) return;
  tr.insertCell().append(positionPnl(row));
  tr.dataset.position = positionKey(row);
  tr.tabIndex = -1;
  const risk = table.insertRow();
  risk.className = "position-risk-row";
  const cell = risk.insertCell();
  cell.colSpan = tr.cells.length;
  const fields = element("dl", "position-risk-fields");
  fields.setAttribute("aria-label", row.coin + " 持仓风险");
  for (const field of details) addHoldingField(fields, ...field);
  cell.append(fields);
}

function appendHoldingCard(container, row, columns, values, details, movable) {
  const card = element("article", "mobile-holding" + (details ? " position-card" : " spot"));
  const top = element("div", "mobile-holding-top");
  const coin = coinCell(row.coin, row.dex);
  const fields = element("dl", details ? "position-card-fields" : "");
  values.forEach((value, index) => addHoldingField(fields, columns[index + (details ? 2 : 1)], value));
  if (details) {
    card.dataset.position = positionKey(row);
    card.tabIndex = -1;
    const identity = element("div", "holding-card-identity");
    identity.append(coin, sideCell(row));
    if (movable) {
      const grip = element("button", "position-grip");
      grip.type = "button";
      grip.dataset.positionGrip = "";
      grip.title = "拖动排列，也可按方向键";
      grip.setAttribute("aria-label", "调整 " + row.coin + " 卡片位置");
      const icon = element("span", "icon");
      icon.setAttribute("aria-hidden", "true");
      setIcon(icon, "grip");
      grip.append(icon);
      top.append(grip);
    }
    top.append(identity, positionPnl(row));
    for (const field of details) addHoldingField(fields, ...field);
  } else top.append(coin);
  card.append(top, fields);
  container.append(card);
}

function renderHoldings() {
  const s = session;
  const body = $("holdings-body");
  if (cardOrdering.active()) return;
  const focusedGrip = document.activeElement.matches("[data-position-grip]");
  const focused = body.contains(document.activeElement) ? document.activeElement.closest("[data-position]")?.dataset.position : null;
  body.dataset.asOf = s.times.get("positions") ?? "";
  $("spot-count").textContent = s.spot?.length ?? "—";
  const spot = tab === "spot";
  const raw = spot ? s.spot : s.positions;
  const query = $("position-search").value;
  const side = $("position-side").value;
  const filtered = query.trim() || side !== "all";
  const sorted = spot || !raw ? raw : filterPositions(raw, { query, side, sort: positionSort.value });
  const list = !spot && sorted && positionSort.value === "manual" ? orderPositions(sorted, loadPreference(orderPreference(s), [])) : sorted;
  if (!spot) {
    const count = list ? (filtered ? list.length + " / " + raw.length : String(raw.length)) : "—";
    $("position-count").textContent = count;
    const status = list && filtered ? "找到 " + list.length + " 个持仓，共 " + raw.length + " 个" : "";
    if ($("position-filter-status").textContent !== status) $("position-filter-status").textContent = status;
  }
  $("position-search-clear").hidden = !query;
  $("holdings-tools").hidden = spot || (!raw?.length && !filtered);
  const preference = spot ? "auto" : positionLayout.value;
  const cards = preference === "cards" || (preference !== "table" && cardMedia.matches);
  body.dataset.layout = cards ? "cards" : "table";
  $("position-order-hint").hidden = spot || !cards || (list?.length ?? 0) < 2;

  if (!list?.length) {
    const type = spot ? "现货余额" : "合约持仓";
    const missing = s.errors.has(tab);
    const message = !s.user && !s.demo ? "选择钱包后查看" + type : missing ? type + "暂时无法更新" :
      raw?.length ? "没有匹配的合约，试试清空搜索或调整方向。" :
      list ? "当前暂无" + (!spot && s.scope === "main" ? "默认市场" : "") + type : "正在读取" + type + "…";
    body.replaceChildren(element("div", "empty-holdings", message));
    return;
  }

  const columns = spot
    ? ["资产", "总数量", "占用数量"]
    : ["合约", "方向", "持仓数量", "开仓价", "标记价", "未实现盈亏"];
  const view = cards ? element("div", "mobile-holdings") : holdingTable(columns, spot);
  if (!cards) view.createTBody();
  const equity = spot ? null : portfolioBrief(s.history).equity;
  for (const row of list) {
    const values = spot
      ? [quantity(row.total), quantity(row.hold)]
      : [quantity(Math.abs(row.size)), holdingPrice(row.entry), holdingPrice(row.mark)];
    const details = spot ? null : [
      ["预估强平价", holdingPrice(row.liquidationText)],
      ["保证金占用", amount(row.margin)],
      ["仓位杠杆率", leverage(row.value, equity)],
    ];
    if (cards) appendHoldingCard(view, row, columns, values, details, list.length > 1);
    else appendHoldingRow(view.tBodies[0], row, values, details);
  }
  body.replaceChildren(view);
  if (!spot) {
    body.append(element("p", "position-risk-note", "仓位杠杆率＝该仓位价值 ÷ 账户总权益。预估强平价来自 Hyperliquid。"));
    if (focused) {
      const target = [...body.querySelectorAll("[data-position]")].find(node => node.dataset.position === focused && node.getClientRects().length);
      (focusedGrip ? target?.querySelector("[data-position-grip]") ?? target : target)?.focus({ preventScroll: true });
    }
    const row = s.focusCoin && list.find(row => row.coin === s.focusCoin);
    if (row && focusPosition(positionKey(row))) s.focusCoin = null;
  }
}

function renderAll() {
  const empty = !session.user && !session.demo;
  $("dashboard-empty").hidden = !empty;
  for (const pane of document.querySelectorAll("[data-wallet-detail]")) pane.hidden = empty;
  syncLayout();
  renderMetrics();
  renderExposure();
  renderChart();
  renderHoldings();
  renderConnection();
}

function renderPositions() {
  renderMetrics();
  renderExposure();
  renderHoldings();
  renderConnection();
}

async function refreshEquitySnapshots(s) {
  if (!account || s.snapshotNext > Date.now()) return;
  s.snapshotNext = Date.now() + 60_000;
  try {
    const response = await fetch("/api/equity-snapshots?" + new URLSearchParams({ wallet: s.user }), {
      signal: s.controller.signal, cache: "no-store", headers: { "X-Hyper-Account": account },
    });
    if (!response.ok) return;
    const snapshots = await response.json();
    if (session !== s) return;
    s.equitySnapshots = snapshots;
    renderMetrics();
    renderChart();
  } catch {
    // Keep the previous samples visible during reconnects.
  }
}

async function refresh(s = session) {
  if (!s.user || s.requesting || session !== s) return;
  refreshOverviewActivity(s);
  refreshEquitySnapshots(s);
  s.requesting = true;
  renderConnection();

  const requests = [
    ["history", "portfolio", parsePortfolio],
    ["spot", "spotClearinghouseState", parseSpot],
  ];
  if (!live(s)) requests.push(["positions", "clearinghouseState", raw => parsePositions([["", raw]])]);

  const ready = requests.filter(([key]) => (s.problems.get(key)?.retryAt ?? 0) <= Date.now());
  await Promise.all(ready.map(async ([key, endpoint, parse]) => {
    try {
      const raw = await info(endpoint, s.user, s.controller.signal);
      if (session !== s || (key === "positions" && live(s))) return;
      s[key] = parse(raw);
      if (key === "positions") s.scope = "main";
      s.requestedAt = Date.now();
      s.times.set(key, s.requestedAt);
      s.problems.delete(key);
      s.errors.delete(key);
      if (key === "positions") renderPositions();
    } catch (error) {
      if (session !== s || (key === "positions" && live(s))) return;
      s.errors.add(key);
      if (!error.retryAt) error.retryAt = Date.now() + (s.problems.has(key) ? 30_000 : 8_000);
      s.problems.set(key, error);
    }
  }));
  if (session !== s) return;
  s.requesting = false;
  renderAll();
}

async function refreshOverviewActivity(s) {
  if (!account || s.activityPending || Date.now() < s.activityNext) return;
  s.activityPending = true;
  s.activityNext = Date.now() + activityEvery;
  try {
    const response = await fetch("/api/overview-activity?" + new URLSearchParams({ wallet: s.user }), {
      headers: { "X-Hyper-Account": account }, cache: "no-store", credentials: "same-origin", signal: s.controller.signal,
    });
    if (!response.ok) throw new Error("Overview activity unavailable");
    s.activity = await response.json();
    const old = s.lastRealized;
    const next = s.activity;
    if (next.fillsState === "ready" && (old?.todayStart !== next.todayStart ||
      (old.realizedAsOf ?? old.asOf) <= (next.realizedAsOf ?? next.asOf))) s.lastRealized = next;
    s.activityError = false;
  } catch {
    s.activityError = true;
  } finally {
    s.activityPending = false;
    if (s === session) {
      renderRealized();
      renderRecentEvents();
    }
  }
}

function openAccount(user, demo = false, focusCoin = null) {
  cardOrdering.cancel();
  if (session) {
    session.controller.abort();
    session.disconnect?.();
  }
  const s = {
    user, demo, focusCoin, controller: new AbortController(), errors: new Set(),
    history: null, equitySnapshots: null, snapshotNext: 0, positions: null, spot: null, requestedAt: 0, requesting: false,
    activity: null, lastRealized: null, activityNext: 0, activityPending: false, activityError: false,
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
      if (autoRefresh && navigator.onLine && !document.hidden && !$("dashboard").hidden && !s.requesting && s.requestedAt) refresh(s);
    });
  } else if (demo) {
    Object.assign(s, demoData());
  }
  savePreference("wallet", user);
  renderAll();
  renderRecentEvents();
  document.dispatchEvent(new Event("hyper-wallet-changed"));
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

function changeOverviewRange(value, persist = true) {
  period = value;
  pnlSummarySelect.value = value;
  if (persist) savePreference("overview-period", value);
  for (const button of $("periods").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.period === value));
  }
  renderMetrics();
  renderChart();
}

registerChoice("periods", "period", changeOverviewRange);
registerChoice("series", "series", value => { series = value; renderChart(); });
registerChoice("holdings-tabs", "tab", value => { cardOrdering.cancel(); tab = value; renderHoldings(); renderConnection(); });
function focusPosition(key) {
  const target = [...$("holdings-body").querySelectorAll("[data-position]")]
    .find(node => node.dataset.position === key && node.getClientRects().length);
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center" });
  return true;
}

const cardOrdering = setupCardOrdering($("holdings-body"), moveHolding, renderHoldings);
const refreshHoldings = () => { cardOrdering.cancel(); renderHoldings(); };
cardMedia.addEventListener("change", refreshHoldings);
$("position-search").addEventListener("input", refreshHoldings);
$("position-search-clear").addEventListener("click", () => {
  const search = $("position-search");
  search.value = "";
  search.focus();
  refreshHoldings();
});
$("position-side").addEventListener("change", refreshHoldings);
for (const control of [positionSort, positionLayout]) {
  control.addEventListener("change", () => { savePreference(control.id, control.value); refreshHoldings(); });
}

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
  if (user !== session.user || (!user && !session.demo)) openAccount(user, !user);
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
pnlSummarySelect.addEventListener("change", () => changeOverviewRange(pnlSummarySelect.value));
function togglePrivacy() {
  masked = !masked;
  savePreference("private", masked);
  renderAll();
  renderRecentEvents();
  workspace.refreshPrivacy();
}
$("privacy").addEventListener("click", togglePrivacy);
$("mobile-privacy").addEventListener("click", togglePrivacy);
$("mobile-refresh").addEventListener("click", () => $("refresh").click());
$("refresh").addEventListener("click", () => {
  if (session.user) { session.activityNext = 0; refresh(); }
  else if (session.demo) { Object.assign(session, demoData()); renderAll(); }
});
$("retry").addEventListener("click", () => refresh());
$("auto-refresh").addEventListener("click", () => {
  autoRefresh = !autoRefresh;
  savePreference("auto-refresh", autoRefresh);
  renderConnection();
  if (autoRefresh && navigator.onLine) refresh();
});

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
    content.replaceChildren(element("p", "hint", s.demo ? "当前为演示数据。" : "添加公开钱包后可检查三类接口。"));
    return;
  }
  const list = element("ul", "diagnostics-list");
  const names = [["history", "权益历史"], ["spot", "现货余额"], ["positions", "合约仓位"]];
  for (const [key, name] of names) {
    const row = element("li");
    const requestTime = s.times.get(key);
    const error = connectionMessage(s.problems.get(key));
    const status = error || (!requestTime ? "等待返回" : s.requesting ? "正在更新" :
      Date.now() - requestTime > 30_000 ? "使用较早的快照" : "数据正常");
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

const alertLink = new URLSearchParams(location.search);
const alertWallet = account && addressOf(alertLink.get("wallet"));
const alertCoin = alertLink.get("position");
if (alertWallet) {
  history.replaceState(null, "", location.pathname + location.hash);
  openAccount(alertWallet, false, /^[a-z0-9:@._\/-]{1,64}$/i.test(alertCoin ?? "") ? alertCoin : null);
} else openAccount(addressOf(loadPreference("wallet", "")));
changeOverviewRange(period, false);
const registration = account && "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : null;
const workspace = setupWorkspace({
  session: () => session,
  observe: openAccount,
  amount, quantity, percent, tone, leverage,
  load: loadPreference, store: savePreference, registration,
  resumeOverview: () => { if (autoRefresh && navigator.onLine && Date.now() - session.requestedAt > pollEvery) refresh(); },
});
$("onboarding-wallet").addEventListener("click", () => workspace.openWallets());
$("onboarding-demo").addEventListener("click", () => selectAddress(""));
const refreshVisible = () => {
  if (!document.hidden && !$("dashboard").hidden && autoRefresh && navigator.onLine) refresh();
};
setInterval(() => {
  if (!autoRefresh && !document.hidden && !$("dashboard").hidden) renderConnection();
  refreshVisible();
}, pollEvery);
document.addEventListener("visibilitychange", () => {
  if (Date.now() - session.requestedAt > pollEvery) refreshVisible();
});
window.addEventListener("offline", () => { renderConnection(); renderRecentEvents(); });
window.addEventListener("online", () => { renderConnection(); renderRecentEvents(); refreshVisible(); });

let installPrompt;
const standalone = matchMedia("(display-mode: standalone)");
const installButton = $("install-app");
const installHelp = $("install-help");
function updateInstall() {
  installButton.hidden = !registration || standalone.matches || navigator.standalone === true;
  if (installButton.hidden) installHelp.hidden = true;
}
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  updateInstall();
});
window.addEventListener("appinstalled", () => { installPrompt = null; installButton.hidden = true; installHelp.hidden = true; });
standalone.addEventListener("change", updateInstall);
installButton.addEventListener("click", async () => {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    try { await prompt.prompt(); return; } catch {}
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  installHelp.textContent = ios ? "在 Safari 点「分享」，再选「添加到主屏幕」。" : "打开浏览器菜单，选择「安装应用」或「添加到主屏幕」。";
  installHelp.hidden = !installHelp.hidden;
});
updateInstall();
