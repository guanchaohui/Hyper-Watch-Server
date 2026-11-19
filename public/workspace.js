import { ledgerRanges, ledgerSections, renderLedger } from "./ledger-panel.js";
import { addressOf, actionLabels, cashMovements, cleanEquityChangeAlert, cleanProfile, day, equityVolatilityDefaults,
  leverageAlertDefault, metricsFor, notificationFieldLabels, riskFields, riskLabels, portfolioBrief, positionChanges, tradeAlertSettings, tradingActivity, walletLimit, walletName } from "./analytics.js";
import { formatNotificationPreview } from "./notification-format.js";
import { info, parsePortfolio, parsePositions } from "./market.js";
import { enablePageSwipe } from "./mobile-swipe.js";

const $ = id => document.getElementById(id);
const mobileViewOf = view => view === "pnl" ? "activity" : view === "wallets" ? "mine" : view;
const swipeContentExclusions = [
  "button", "a", "input", "select", "textarea", "label", "summary", "canvas", "[contenteditable]",
  "#mobile-wallet-strip", ".data-scroll", '.holdings-body[data-layout="table"]',
  ".workspace-panel:has(#save-rules, #save-watch)", "#overview-layout[data-editing]",
].join(",");
const siteRuntime = document.documentElement.dataset.runtime === "site";
const account = document.documentElement.dataset.account;
const formatting = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const inboxDay = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const inboxClock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const inboxLabels = { all: "全部提醒", fill: "仓位变动", equity: "账户权益", leverage: "总杠杆", risk: "仓位风险" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const tip = text => '<div class="list-state">' + esc(text) + "</div>";
const panel = html => '<section class="panel workspace-panel">' + html + '</section>';
const choose = (value, active, text) => '<option value="' + esc(value) + '"' + (value === active ? " selected" : "") + ">" + esc(text) + "</option>";
const field = (label, content, css = "") => '<label class="field ' + css + '"><span>' + esc(label) + '</span>' + content + '</label>';
const button = (id, value, extra = "") => '<button class="btn ' + extra + '" type="button" id="' + id + '">' + esc(value) + '</button>';
const titled = (title, subtitle) => '<div class="workspace-heading"><div><h1>' + esc(title) + '</h1><p>' + esc(subtitle) + '</p></div></div>';
const check = (name, key, value, label) => '<label class="check"><input type="checkbox" name="' + esc(name) + '" value="' + esc(key) + '"' + (value ? ' checked' : '') + '>' + esc(label) + '</label>';

async function request(path, method = "GET", data) {
  const response = await fetch(path, {
    method, cache: "no-store", credentials: "same-origin",
    headers: { "X-Hyper-Account": account, ...(data !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) location.replace("/");
  if (!response.ok) throw Object.assign(new Error(payload.error || "请求失败（" + response.status + "）"), { status: response.status, payload });
  return payload;
}

function table(columns, rows) {
  if (!rows.length) return tip("暂无持仓");
  return '<div class="data-scroll"><table class="detail-table"><thead><tr>' + columns.map(name => '<th scope="col">' + esc(name) + '</th>').join("") +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map((cell, i) => '<td data-label="' + esc(columns[i]) + '">' + cell + '</td>').join("") + '</tr>').join("") + '</tbody></table></div>';
}

export function setupWorkspace(ui) {
  const dashboard = $("dashboard");
  const viewRoot = $("workspace-view");
  const mobileTabs = $("mobile-tabs");
  const mobileViews = [...mobileTabs.querySelectorAll("[data-view]")].map(button => button.dataset.view);
  const comparison = $("overview-comparison");
  const comparisonContent = $("overview-comparison-content");
  let profile = cleanProfile(ui.load("workspace", {}));
  let active = "over";
  let revision = 0;
  let syncMessage = siteRuntime ? "同步连接中" : "设置保存在本机";
  let dirty = ui.load("workspace-pending", false) === true;
  let conflict = null;
  let busy = false;
  let sequence = 0;
  let editing = "";
  let watchGroup = "";
  let favoritesOnly = false;
  let compareAddresses = ui.load("comparison-wallets", null);
  let compareFilter = "all";
  let activityAddress = "";
  let pnlAddress = "";
  let range = "7";
  let pnlMode = ui.load("pnl-mode", "ledger");
  let ledgerView = "summary";
  let ledgerPeriod = ui.load("ledger-period", "today");
  if (!Object.hasOwn(ledgerRanges, ledgerPeriod)) ledgerPeriod = "today";
  let ledgerPages = [], ledgerNext = null;
  let eventFilter = "all";
  let inboxKind = "all", inboxUnread = false;
  let inboxItems = [], inboxNext = null, inboxExpanded = false, inboxRequest = 0;
  let pushConfig, pushRegistration;
  const briefCache = new Map();
  const fillsCache = new Map();

  function cachedRead(cache, key, lifetime, read) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < lifetime) return cached.result;
    const entry = { at: Date.now(), result: Promise.resolve().then(read) };
    cache.set(key, entry);
    entry.result.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return entry.result;
  }

  function recentFills(address) {
    return cachedRead(fillsCache, address, 40_000, async () => {
      const rows = await info("userFillsByTime", address, undefined, { startTime: Date.now() - 7 * day, aggregateByTime: true });
      if (!Array.isArray(rows)) throw new Error("成交记录格式异常");
      return rows;
    });
  }

  const briefOnly = (address, allMarkets = false) => cachedRead(briefCache, address + (allMarkets ? ":all" : ""), 10_000, async () => {
    const [history, positions] = await Promise.allSettled([
      info("portfolio", address).then(parsePortfolio),
      allMarkets && siteRuntime ? request("/api/positions?wallet=" + address).then(result => result.positions) :
        info("clearinghouseState", address).then(raw => parsePositions([["", raw]])),
    ]);
    if (history.status === "rejected" && positions.status === "rejected") throw history.reason;
    return { at: Date.now(), history: history.value ?? null, positions: positions.value ?? null };
  });

  function selectDefaultWallet() {
    const current = ui.session();
    const wallet = own() ?? profile.wallets[0];
    if (!current.user && !current.demo && wallet) ui.observe(wallet.address);
  }

  function quickWallets() {
    return [...profile.wallets].sort((a, b) => Number(b.role === "mine") - Number(a.role === "mine") ||
      Number(b.pinned) - Number(a.pinned) || Number(b.favorite) - Number(a.favorite));
  }

  function renderMobileWallet() {
    const wallets = quickWallets();
    $("mobile-wallet-strip").hidden = !wallets.length;
    if (!wallets.length) return;
    const current = ui.session();
    const index = wallets.findIndex(wallet => wallet.address === current.user);
    const wallet = wallets[index];
    const role = wallet?.role === "mine" ? "我的钱包" : wallet?.pinned || wallet?.favorite ? "重点观察" : "关注钱包";
    $("wallet-switcher-role").textContent = wallet ? role + " · " + (index + 1) + " / " + wallets.length : "钱包快切";
    $("wallet-switcher-name").textContent = wallet ? walletName(wallet) : current.demo ? "演示数据" : "选择已保存钱包";
    $("wallet-prev").disabled = $("wallet-next").disabled = index >= 0 && wallets.length < 2;
  }

  function stepWallet(direction) {
    const wallets = quickWallets();
    if (!wallets.length) return;
    const index = wallets.findIndex(wallet => wallet.address === ui.session().user);
    const next = index < 0 ? (direction > 0 ? 0 : wallets.length - 1) : (index + direction + wallets.length) % wallets.length;
    if (next !== index) ui.observe(wallets[next].address);
  }

  const persistLocal = () => {
    ui.store("workspace", profile);
    ui.store("workspace-pending", dirty);
    document.body.classList.toggle("quick-mode", profile.quick);
    ui.syncOverview();
    $("toggle-quick").setAttribute("aria-pressed", String(profile.quick));
    $("mobile-quick").setAttribute("aria-pressed", String(profile.quick));
    $("mobile-quick-label").textContent = profile.quick ? "退出快看" : "快看";
    selectDefaultWallet();
    renderMobileWallet();
  };

  function syncStatus() {
    const area = $("sync-status");
    if (!area) return;
    area.textContent = syncMessage + (dirty && !conflict && !busy && siteRuntime ? " · 有本机更改待同步" : "");
    const actions = $("sync-actions");
    if (actions) actions.hidden = !conflict;
  }

  async function sync(push = false) {
    if (!siteRuntime || busy || conflict) return;
    busy = true;
    try {
      if (push && dirty) {
        const snapshot = JSON.stringify(profile);
        const result = await request("/api/profile", "PUT", { profile, revision });
        revision = result.revision;
        dirty = snapshot !== JSON.stringify(profile);
        persistLocal();
        if (active === "alerts") refreshEquityLevels();
      } else {
        const result = await request("/api/profile");
        if (result.revision > revision && dirty && revision !== result.revision) {
          conflict = result;
          syncMessage = "其他设备修改了设置，请选择保留的版本";
          syncStatus();
          return;
        }
        if (result.revision > revision && result.profile) {
          profile = cleanProfile(result.profile);
          persistLocal();
          if (!viewRoot.contains(document.activeElement) || document.activeElement.tagName === "BODY") render();
        }
        revision = result.revision;
      }
      syncMessage = dirty ? "同步中" : "跨设备已同步";
    } catch (error) {
      if (error.status === 409) {
        conflict = error.payload;
        syncMessage = "其他设备修改了设置，请选择保留的版本";
      } else {
        syncMessage = error.status === 400 ? error.message : "同步暂时不可用，设置保存在本机";
        return;
      }
    } finally {
      busy = false;
      syncStatus();
    }
    if (dirty && !conflict) sync(true);
  }

  function update(next) {
    const currentWallet = profile.wallets.find(wallet => wallet.role === "mine")?.address;
    const nextWallet = next.wallets.find(wallet => wallet.role === "mine")?.address;
    const rules = next.rules;
    if (rules.equityMode === "percent" && Number(rules.equity) > 0 &&
        (profile.rules.equityMode !== "percent" || !profile.rules.equity || currentWallet !== nextWallet || !rules.equityTrackingId)) {
      next = { ...next, rules: { ...rules, equityTrackingId: crypto.randomUUID() } };
    }
    profile = cleanProfile(next);
    if (siteRuntime) dirty = true;
    persistLocal();
    render();
    if (siteRuntime) sync(true);
  }

  function keepVersion(cloud) {
    if (!conflict) return;
    revision = conflict.revision;
    if (cloud) {
      profile = cleanProfile(conflict.profile);
      dirty = false;
    }
    conflict = null;
    persistLocal();
    render();
    sync(!cloud);
  }

  const syncFragment = () => '<span id="sync-status" class="status-inline" aria-live="polite"></span><div class="inline-row" id="sync-actions" hidden>' +
    button("use-cloud", "使用云端设置") + button("use-device", "保留本机设置") + '</div>';

  const options = (current, list = profile.wallets) => list.map(wallet => choose(wallet.address, current, walletName(wallet))).join("");
  const select = (id, current, list) => '<select id="' + id + '">' + options(current, list) + '</select>';
  const noWallet = text => panel(tip(text) + button("goto-wallets", "添加钱包"));
  const own = () => profile.wallets.find(wallet => wallet.role === "mine");
  const selectedWallet = address => profile.wallets.find(wallet => wallet.address === address);
  const money = ui.amount;
  const quantity = ui.quantity;

  async function loadCards() {
    const cards = [...viewRoot.querySelectorAll("[data-card]")];
    await Promise.allSettled(cards.map(async card => {
      let value;
      try {
        const data = await briefOnly(card.dataset.card);
        const summary = portfolioBrief(data.history);
        const positions = data.positions;
        const longs = positions?.filter(row => row.size > 0).length ?? 0;
        const shorts = positions?.filter(row => row.size < 0).length ?? 0;
        const details = positions ? (positions.length ? "默认合约市场 " + longs + " 多 / " + shorts + " 空" : "默认合约市场无持仓") : "持仓暂不可用";
        value = '<dl class="watch-values"><div><dt>账户权益</dt><dd>' + esc(money(summary.equity)) +
          '</dd></div><div><dt>24 小时盈亏</dt><dd class="' + ui.tone(summary.pnl) + '">' + esc(money(summary.pnl, { signed: true })) +
          '</dd></div></dl><p class="watch-meta">' + esc(details) + ' · ' + esc(formatting.format(data.at)) + '</p>';
      } catch {
        value = '<p class="watch-meta">更新失败，可刷新重试</p>';
      }
      if (card.isConnected) card.innerHTML = value;
    }));
  }

  function walletsPage() {
    const list = [...profile.wallets].sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
      Number(b.favorite) - Number(a.favorite) || Number(b.role === "mine") - Number(a.role === "mine"));
    const groups = [...new Set(list.map(row => row.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh"));
    if (watchGroup.startsWith("group:") && !groups.includes(watchGroup.slice(6))) watchGroup = "";
    const groupPicker = list.length ? '<div class="workspace-toolbar">' +
      field("分组筛选", '<select id="wallet-group-filter">' + choose("", watchGroup, "全部分组") +
      choose("ungrouped", watchGroup, "未分组") + groups.map(group => choose("group:" + group, watchGroup, group)).join("") +
      '</select>') + check("favorites-only", "on", favoritesOnly, "只看收藏") + '</div>' : "";
    const wallet = selectedWallet(editing);
    const { tradeCooldown, minTradeValue } = tradeAlertSettings(wallet);
    const prefill = wallet?.address ?? (ui.session().user && !selectedWallet(ui.session().user) ? ui.session().user : "");
    const cards = list.filter(row => (!watchGroup || (watchGroup === "ungrouped" ? !row.group : "group:" + row.group === watchGroup)) &&
      (!favoritesOnly || row.favorite)).map(row => {
      const short = row.address.slice(0, 6) + "…" + row.address.slice(-4);
      return '<article class="watch-card ' + (row.role === "mine" ? "own" : "") + '"><div class="watch-header"><span class="watch-title"><strong>' +
        esc(walletName(row)) + '</strong><span class="tag ' + row.role + '">' + (row.role === "mine" ? "我的钱包" : "关注") +
        '</span></span><div class="watch-flags"><button class="quiet-link" type="button" data-watch-action="favorite" aria-pressed="' + row.favorite + '" data-address="' + row.address + '">' +
        (row.favorite ? "取消收藏" : "收藏") + '</button><button class="quiet-link" type="button" data-watch-action="pin" aria-pressed="' + row.pinned + '" data-address="' + row.address + '">' +
        (row.pinned ? "取消置顶" : "置顶") + '</button></div></div><p class="watch-meta" title="' + row.address + '">' + esc(short + (row.group ? " · " + row.group : "")) +
        (row.notify ? " · 动态提醒已勾选" : "") + '</p><div data-card="' + row.address + '" class="card-readout"><p class="watch-meta">正在读取余额和仓位…</p></div>' +
        '<div class="inline-row"><button type="button" class="btn" data-watch-action="observe" data-address="' + row.address + '">观察</button>' +
        '<button type="button" class="btn" data-watch-action="edit" data-address="' + row.address + '">编辑</button></div></article>';
    }).join("");
    viewRoot.innerHTML = titled("钱包列表", "同一页查看自己的钱包和关注对象。") +
      groupPicker + (cards ? '<section class="watch-cards">' + cards + '</section>' :
        list.length ? panel(tip("当前分组或收藏条件下没有钱包。")) : "") +
      panel('<h2>' + (wallet ? "编辑钱包" : "添加钱包") + '</h2><div class="wallet-editor">' +
        field("公开地址", '<input id="watch-address" maxlength="42" placeholder="0x…" autocomplete="off" spellcheck="false" value="' + esc(prefill) + '"' + (wallet ? " readonly" : "") + '>', "address-field") +
        field("备注", '<input id="watch-name" maxlength="28" placeholder="例如 我的主账户" value="' + esc(wallet?.name ?? "") + '">') +
        field("分组", '<input id="watch-group" list="wallet-groups" maxlength="18" placeholder="选择或创建分组" value="' + esc(wallet?.group ?? "") +
          '"><datalist id="wallet-groups">' + groups.map(group => '<option value="' + esc(group) + '"></option>').join("") + '</datalist>') +
        field("用途", '<select id="watch-role">' + choose("watch", wallet?.role ?? (list.length ? "watch" : "mine"), "关注") +
          choose("mine", wallet?.role ?? (list.length ? "watch" : "mine"), "我的钱包") + '</select>') +
        button("save-watch", wallet ? "保存" : "添加") + '</div>' +
        '<div class="inline-row">' + check("watch-notify", "on", wallet?.notify, "接收这个钱包的仓位变动") +
        (wallet ? '<div>' + button("cancel-edit", "取消编辑") + ' ' + button("remove-watch", "移除") + '</div>' : '') + '</div>' +
        '<details class="wallet-alert-options"' + (wallet?.notify ? ' open' : '') + '><summary>成交降噪设置</summary><div class="rule-thresholds">' +
        field("加减仓合并窗口（秒）", '<input id="trade-cooldown" type="number" min="0" max="300" step="1" value="' + tradeCooldown + '">') +
        field("合并后的最低名义金额（USD）", '<input id="min-trade-value" type="number" min="0" max="1000000000000" step="any" value="' + minTradeValue + '">') +
        '</div><p class="hint">每个钱包独立设置。窗口填 0 逐笔检查，金额填 0 接收所有金额。开仓、平仓和反手即时处理。</p></details>' +
        (!list.length ? '<p class="hint">添加公开地址即可开始监控。保存为「我的钱包」后可设置权益和杠杆提醒。</p>' : '') +
        '<span id="wallet-message" class="status-inline" role="status"></span>' + syncFragment());
    loadCards();
  }

  function saveWallet() {
    const address = addressOf($("watch-address").value);
    const message = $("wallet-message");
    if (!address) { message.textContent = "请输入 42 个字符的 0x 钱包地址。"; $("watch-address").focus(); return; }
    if (!editing && selectedWallet(address)) { message.textContent = "这个钱包已在列表中。"; return; }
    if (!editing && profile.wallets.length >= walletLimit) { message.textContent = "已达到 " + walletLimit + " 个钱包。"; return; }
    for (const input of [$("trade-cooldown"), $("min-trade-value")]) {
      if (!input.validity.valid) {
        input.closest("details").open = true;
        input.reportValidity();
        return;
      }
    }
    const role = $("watch-role").value;
    const row = {
      address, role, name: $("watch-name").value, group: $("watch-group").value,
      pinned: selectedWallet(address)?.pinned ?? false, favorite: selectedWallet(address)?.favorite ?? false,
      notify: viewRoot.querySelector('[name="watch-notify"]').checked,
      ...tradeAlertSettings({ tradeCooldown: $("trade-cooldown").value, minTradeValue: $("min-trade-value").value }),
    };
    const others = profile.wallets.filter(wallet => wallet.address !== address).map(wallet =>
      role === "mine" && wallet.role === "mine" ? { ...wallet, role: "watch" } : wallet);
    editing = "";
    update({ ...profile, wallets: [...others, row] });
  }

  function chooseWallet(current) {
    return selectedWallet(current)?.address ?? selectedWallet(ui.session().user)?.address ?? own()?.address ?? profile.wallets[0]?.address ?? ui.session().user;
  }

  const realInputs = () => profile.wallets.length ? profile.wallets : ui.session().user ? [{ address: ui.session().user, name: "当前钱包" }] : [];
  function activityPage(token) {
    const list = realInputs();
    activityAddress = chooseWallet(activityAddress);
    viewRoot.innerHTML = titled("仓位动态", "查看近 7 天的开仓、加仓、减仓、平仓和反手。") +
      (!activityAddress ? noWallet("先添加一个公开钱包，即可查看仓位变化。") : panel(
        '<div class="workspace-toolbar">' + field("观察钱包", select("activity-wallet", activityAddress, list), "flex") +
        field("变动类型", '<select id="event-filter">' + choose("all", eventFilter, "全部变动") + Object.entries(actionLabels).map(([value, name]) => choose(value, eventFilter, name)).join("") + '</select>') +
        button("refresh-view", "刷新") + '</div><div id="activity-summary"></div><div id="activity-data">' + tip("正在读取成交记录…") + '</div>'));
    if (!activityAddress) return;
    recentFills(activityAddress).then(raw => {
      if (token !== sequence) return;
      const changes = positionChanges(raw);
      const rows = changes.filter(row => eventFilter === "all" || row.action === eventFilter).reverse();
      if (changes.length) {
        const stats = tradingActivity(changes);
        const hours = stats.peakHours.map(hour => String(hour).padStart(2, "0") + ":00").join("、");
        const summary = [["成交名义额", money(stats.volume)], ["已实现盈亏", money(stats.realized, { signed: true })],
          ["盈利的减仓／平仓／反手", stats.known ? stats.profitable + " / " + stats.known : "—"], ["最活跃时段 · UTC+8", hours || "—"]];
        $("activity-summary").innerHTML = '<h2>近 7 天交易行为</h2><div class="readout-grid">' +
          summary.map(([name, value]) => '<div class="readout"><small>' + esc(name) + '</small><strong>' + esc(value) + '</strong></div>').join("") +
          '</div><p class="hint">' + esc(Object.entries(stats.actions).map(([action, count]) => actionLabels[action] + " " + count).join(" · ")) +
          '</p><p class="hint">' + esc("成交额靠前 " + stats.topCoins.map(([coin, value]) => coin + " " + money(value)).join(" · ")) + '</p>';
      }
      $("activity-data").innerHTML = (raw.length >= 2000 ? '<p class="hint">成交量较大，已达到接口的单次返回上限。</p>' : '') +
        (rows.length ? '<div class="timeline">' + rows.slice(0, 100).map(row => {
          const direction = (row.end || row.start) > 0 ? "多" : "空";
          return '<div class="timeline-row"><time>' + esc(formatting.format(row.time)) + '</time><strong>' + esc(row.coin) +
            '</strong><div><span class="tag">' + esc(actionLabels[row.action] + " " + direction) + '</span> ' +
            esc(quantity(row.size) + " @ " + money(row.price)) + (row.cut === null ? "" : " · " + esc(ui.percent(row.cut))) + '</div></div>';
        }).join("") + '</div>' + (rows.length > 100 ? '<p class="hint">显示最近 100 条匹配记录。</p>' : '') : tip("这个时段没有匹配的合约仓位变动。"));
    }).catch(error => { if (token === sequence) $("activity-data").innerHTML = tip("无法获取成交记录。 " + (error.status ? "HTTP " + error.status : (error.timeout ? "请求超时" : "连接或响应异常"))); });
  }

  function renderComparison() {
    if (!comparison.open) return;
    const mine = own();
    const watch = profile.wallets.filter(row => row.address !== mine?.address);
    if (!mine || !watch.length) {
      comparisonContent.innerHTML = tip("在「钱包」设置我的钱包，并添加一个关注钱包。");
      return;
    }
    compareAddresses = Array.isArray(compareAddresses) ? watch.filter(wallet => compareAddresses.includes(wallet.address))
      .slice(0, 3).map(wallet => wallet.address) : [watch[0].address];
    const peers = watch.filter(wallet => compareAddresses.includes(wallet.address));
    const selected = [mine, ...peers];
    comparisonContent.innerHTML = '<fieldset class="compare-choices"><legend>对比钱包（最多选 3 个）</legend><div class="rule-actions">' +
      watch.map(wallet => {
        const checked = compareAddresses.includes(wallet.address);
        return '<label class="check"><input type="checkbox" name="compare-wallet" value="' + wallet.address + '"' +
          (checked ? " checked" : peers.length >= 3 ? " disabled" : "") + '>' + esc(walletName(wallet)) + '</label>';
      }).join("") + '</div></fieldset><div class="workspace-toolbar">' +
      field("合约范围", '<select id="compare-filter">' + choose("all", compareFilter, "全部") +
        choose("common", compareFilter, "共同持仓") + choose("different", compareFilter, "方向或持仓不同") + '</select>') +
      button("refresh-comparison", "刷新") + '</div><div id="compare-data" aria-live="polite">' +
      tip(peers.length ? "正在读取所选钱包的仓位…" : "勾选至少一个关注钱包。") + '</div>';
    if (!peers.length) return;
    const output = $("compare-data");
    Promise.all(selected.map(async (wallet, index) => {
      const [snapshot, recent] = await Promise.allSettled([
        briefOnly(wallet.address, true), index ? recentFills(wallet.address) : [],
      ]);
      const data = snapshot.value;
      const positions = data?.positions ? new Map(data.positions.map(row => [row.coin, row])) : null;
      const lastChanges = new Map(positionChanges(recent.value).map(change => [change.coin, change]));
      const closed = new Set([...lastChanges].filter(([coin, change]) => change.action === "close" &&
        (siteRuntime || !coin.includes(":")) && positions && !positions.has(coin)).map(([coin]) => coin));
      return { positions, closed, equity: portfolioBrief(data?.history).equity, flowsMissing: index > 0 && recent.status === "rejected" };
    })).then(snapshots => {
      if (!output.isConnected || !comparison.open) return;
      if (!snapshots.some(data => data.positions)) { output.innerHTML = tip("所选钱包的仓位暂时无法读取，请重试。"); return; }
      const complete = snapshots.every(data => data.positions);
      const symbols = new Set(snapshots.flatMap(data => [...(data.positions?.keys() ?? []), ...data.closed]));
      const rows = [...symbols].sort().flatMap(coin => {
        const holdings = snapshots.map(data => data.positions?.get(coin));
        const directions = new Set(holdings.filter(Boolean).map(row => Math.sign(row.size)));
        const common = holdings.every(Boolean);
        if (complete && ((compareFilter === "common" && !common) ||
          (compareFilter === "different" && (common && directions.size === 1 || !directions.size)))) return [];
        const cells = holdings.map((row, index) => {
          const data = snapshots[index];
          if (!data.positions) return "待更新";
          if (!row) return data.closed.has(coin) ? "近 7 天已平仓" : "当前无仓";
          return esc((row.size > 0 ? "多" : "空") + " " + quantity(Math.abs(row.size))) +
            '<div class="subtle">' + esc("均价 " + money(row.entry) + " · 杠杆 " + ui.leverage(row.value, data.equity)) +
            '</div><div class="subtle ' + ui.tone(row.pnl) + '">' + esc("浮盈亏 " + money(row.pnl, { signed: true })) + '</div>';
        });
        const relation = !complete ? "数据不全" : !directions.size ? "近 7 天平仓" :
          directions.size > 1 ? "多空不同" : common ? "全部同向" : "部分持有";
        return [[esc(coin), ...cells, relation]];
      });
      output.innerHTML = (!complete ? '<p class="hint">部分仓位读取失败，已显示可用数据。</p>' : '') +
        (snapshots.some(data => data.flowsMissing) ? '<p class="hint">部分钱包的近期平仓记录暂不可读。</p>' : '') +
        (rows.length ? table(["合约", ...selected.map(walletName), "方向对比"], rows) : tip("当前筛选下没有可对比的仓位。"));
    }).catch(() => { if (output.isConnected && comparison.open) output.innerHTML = tip("仓位暂时无法读取，请稍后刷新。"); });
  }

  function ledgerPage(token) {
    const options = (values, current) => Object.entries(values).map(([value, label]) => choose(value, current, label)).join("");
    viewRoot.innerHTML = titled("盈亏与交易账本", "记录成交、费用、资金流水和仓位历史。") +
      panel('<div class="workspace-toolbar">' +
        field("观察钱包", select("pnl-wallet", pnlAddress, realInputs()), "flex") +
        field("查看方式", '<select id="pnl-mode">' + choose("ledger", "ledger", "交易账本") + choose("live", "ledger", "实时盈亏拆分") + '</select>') +
        field("记录", '<select id="ledger-view">' + options(ledgerSections, ledgerView) + '</select>') +
        (ledgerView === "open" ? "" : field("统计区间", '<select id="ledger-period">' + options(ledgerRanges, ledgerPeriod) + '</select>')) +
        button("refresh-view", "刷新") + '</div><div id="pnl-data" aria-live="polite">' + tip("正在读取交易账本…") + '</div>' +
        '<div class="workspace-toolbar">' + button("ledger-prev", "上一页") + button("ledger-next", "下一页") + '</div>');
    $("ledger-prev").hidden = ledgerPages.length === 0;
    $("ledger-next").hidden = true;
    ledgerNext = null;
    const query = new URLSearchParams({ wallet: pnlAddress, view: ledgerView, period: ledgerPeriod });
    const cursor = ledgerPages.at(-1);
    if (cursor) {
      query.set("before", cursor.time);
      query.set("id", cursor.id);
    }
    request("/api/ledger?" + query).then(result => {
      if (token !== sequence) return;
      $("pnl-data").innerHTML = renderLedger(ledgerView, result, { esc, table, tip, ui });
      ledgerNext = result.next;
      $("ledger-next").hidden = !ledgerNext;
    }).catch(() => {
      if (token === sequence) $("pnl-data").innerHTML = tip("账本暂时无法读取，请刷新重试。");
    });
  }

  function pnlPage(token) {
    pnlAddress = chooseWallet(pnlAddress);
    const saved = siteRuntime && profile.wallets.some(wallet => wallet.address === pnlAddress);
    if (saved && pnlMode !== "live") { ledgerPage(token); return; }
    viewRoot.innerHTML = titled("盈亏拆分", "按区间汇总成交和资金流水，当前浮盈单独显示。") +
      (!pnlAddress ? noWallet("添加钱包后可查看盈亏拆分。") : panel(
        '<div class="workspace-toolbar">' + field("观察钱包", select("pnl-wallet", pnlAddress, realInputs()), "flex") +
        (saved ? field("查看方式", '<select id="pnl-mode">' + choose("ledger", "live", "交易账本") + choose("live", "live", "实时盈亏拆分") + '</select>') : "") +
        field("区间", '<select id="pnl-range">' + ["1", "7", "30"].map(value => choose(value, range, value + " 天")).join("") + '</select>') +
        button("refresh-view", "刷新") + '</div><div id="pnl-data">' + tip("正在读取成交、资金流水和当前持仓…") + '</div>'));
    if (!pnlAddress) return;
    const startTime = Date.now() - Number(range) * day;
    Promise.allSettled([
      info("userFillsByTime", pnlAddress, undefined, { startTime, aggregateByTime: true }),
      info("userFunding", pnlAddress, undefined, { startTime }),
      info("userNonFundingLedgerUpdates", pnlAddress, undefined, { startTime }),
      briefOnly(pnlAddress),
    ]).then(([fills, funding, ledger, brief]) => {
      if (token !== sequence) return;
      const rows = result => Array.isArray(result.value) ? result.value : null;
      const ledgerRows = rows(ledger);
      const totals = metricsFor(rows(fills), rows(funding), ledgerRows);
      const movements = cashMovements(ledgerRows).filter(item => item.time > 0).sort((a, b) => b.time - a.time);
      const positions = brief.value?.positions;
      const floating = positions?.every(row => row.pnl !== null) ? positions.reduce((sum, row) => sum + row.pnl, 0) : null;
      const feeDisplay = totals.fees === null ? "—" : totals.fees.length ? totals.fees.map(([token, value]) => money(value, { symbol: "", unit: token })).join(" / ") : money(0, { symbol: "" });
      const cards = [["已实现盈亏", money(totals.realized, { signed: true })], ["当前浮盈亏 · 默认合约市场", money(floating, { signed: true })],
        ["成交手续费 · 原币种", feeDisplay], ["资金费 · 接口金额", money(totals.funding, { signed: true })],
        ["净充值提现 · USDC", money(totals.cashFlow, { signed: true })]];
      $("pnl-data").innerHTML = '<div class="readout-grid">' + cards.map(([name, value]) => '<div class="readout"><small>' + esc(name) + '</small><strong>' + esc(value) + '</strong></div>').join("") +
        '</div><p class="hint">已实现盈亏按成交接口的 closedPnl 汇总。入金和出金单独列出。</p>' +
        (ledgerRows === null ? '' : '<h2>入金与出金</h2>' + (movements.length ? '<div class="timeline">' +
          movements.slice(0, 15).map(item => '<div class="timeline-row"><time>' + esc(formatting.format(item.time)) + '</time><span>' +
            (item.type === "deposit" ? "入金 " : "出金 ") +
            esc(money(item.type === "deposit" ? item.amount : -item.amount, { signed: true })) + '</span></div>').join("") + '</div>' +
          (movements.length > 15 ? '<p class="hint">显示最近 15 笔。</p>' : '') : tip("该区间暂无出入金记录。"))) +
        (totals.truncated ? '<p class="hint">成交达到接口返回上限，金额可能不完整。可选择更短区间。</p>' : '') +
        ([fills, funding, ledger, brief].some(item => item.status === "rejected") ? '<p class="hint">部分数据读取失败，对应项目显示为 —。</p>' : '');
    });
  }

  const tradeNotificationSettings = () => ({
    notificationFields: [...viewRoot.querySelectorAll('[name="notification-field"]:checked')].map(item => item.value),
    notificationPositionUnit: $("notification-position-unit").value,
  });

  function readEquityChangeRule() {
    return cleanEquityChangeAlert({
      up: $("equity-change-up").value,
      down: $("rule-equity-downside").value === "rolling" ? $("equity-change-down").value : null,
    });
  }

  let previewWalletName = ui.load("notification-preview-wallet", "示例钱包");
  let previewType = "trade";
  const downsideModes = { off: "关闭", rolling: "从上次提醒基准下跌", percent: "从最高权益回落", amount: "降至固定金额" };
  const downsideInputIds = { rolling: "equity-change-down", percent: "rule-equity-percent", amount: "rule-equity" };

  const volatilityFields = () => ({ minutes: $("volatility-minutes").value, threshold: $("volatility-threshold").value });

  function notificationPreviewSettings() {
    return {
      type: $("notification-preview-type").value,
      name: previewWalletName,
      ...tradeNotificationSettings(),
      up: $("equity-change-up").value,
      down: $("equity-change-down").value,
      downsideMode: $("rule-equity-downside").value,
      amount: $("rule-equity").value,
      peakDrop: $("rule-equity-percent").value,
      volatility: volatilityFields(),
      leverage: $("leverage-threshold").value,
    };
  }

  function updateNotificationPreview() {
    const settings = notificationPreviewSettings();
    $("notification-position-setting").hidden = !settings.notificationFields.includes("position");
    $("preview-wallet-field").hidden = settings.type !== "trade" || !settings.notificationFields.includes("wallet");
    const content = formatNotificationPreview(settings);
    $("notification-preview-title").textContent = content.title;
    $("notification-preview-body").textContent = content.body;
    $("notification-preview-body").hidden = !content.body;
  }

  function alertPage() {
    const rule = profile.rules;
    const equityChangeRule = rule.equityChangeAlert;
    const volatility = rule.equityVolatility ?? equityVolatilityDefaults;
    const downsideMode = rule.equity ? rule.equityMode : equityChangeRule?.down ? "rolling" : "off";
    viewRoot.innerHTML = titled("提醒设置", "设置仓位变动、账户权益涨跌幅和我的钱包阈值。") +
      panel('<h2>仓位变动</h2><div class="rule-actions">' +
        Object.entries(actionLabels).map(([key, label]) => check("rule-action", key, rule.actions.includes(key), label)).join("") +
        '</div><p class="hint">钱包列表中勾选「接收这个钱包的仓位变动」后适用。</p><h2>交易通知内容</h2><div class="rule-actions">' +
        Object.entries(notificationFieldLabels).map(([key, label]) => check("notification-field", key, rule.notificationFields.includes(key), label)).join("") +
        '</div><p class="hint">可只保留标题。已实现盈亏只在减仓、平仓或反手时显示。</p>' +
        '<div id="notification-position-setting" class="notification-position-setting">' +
        field("仓位变化显示", '<select id="notification-position-unit" aria-describedby="notification-position-note">' +
          choose("usd", rule.notificationPositionUnit, "名义价值（USD）") +
          choose("quantity", rule.notificationPositionUnit, "张数") + '</select>') +
        '<p class="hint" id="notification-position-note">前后仓位使用同一个成交价折算，合并通知使用成交均价。</p></div>' +
        '<div class="notification-preview"><h3>通知预览</h3>' + field("预览类型", '<select id="notification-preview-type">' +
          choose("trade", previewType, "交易通知") + choose("up", previewType, "权益上涨提醒") +
          choose("down", previewType, "权益下跌提醒") + choose("volatility", previewType, "权益短时波动") +
          choose("leverage", previewType, "总杠杆超限") + '</select>') +
        '<div id="preview-wallet-field">' + field("预览钱包名称", '<input id="preview-wallet-name" maxlength="28" value="' +
          esc(previewWalletName) + '" placeholder="示例钱包">') + '</div>' +
        '<div class="notification-preview-content" aria-live="polite">' +
          '<strong id="notification-preview-title"></strong><p id="notification-preview-body"></p></div>' +
        '<p class="hint">预览使用示例数据。发送前，请先开启本机通知。</p>' +
        '<div class="notification-preview-actions">' + button("push-preview", "发送当前预览") +
        '<span id="push-preview-feedback" class="status-inline" role="status"></span></div></div>' +
        '<h2>我的账户权益提醒</h2><p class="hint">监控「我的钱包」的账户总权益。今日涨跌幅按 UTC+8 零点起算。</p>' +
        '<div class="rule-thresholds">' +
        field("上涨达到（%）", '<input type="number" min="0.01" max="100" step="any" id="equity-change-up" value="' + esc(equityChangeRule?.up ?? "") + '">') +
        field("下跌提醒方式", '<select id="rule-equity-downside">' +
          Object.entries(downsideModes).map(([mode, label]) => choose(mode, downsideMode, label)).join("") + '</select>') +
        '<div id="rule-equity-rolling-field"' + (downsideMode === "rolling" ? "" : " hidden") + '>' +
          field("下跌达到（%）", '<input type="number" min="0.01" max="100" step="any" id="equity-change-down" value="' + esc(equityChangeRule?.down ?? "") + '">') +
        '</div><div id="rule-equity-amount-field"' + (downsideMode === "amount" ? "" : " hidden") + '>' +
          field("权益降到（USD）", '<input type="number" min="0.01" max="1000000000000" step="any" id="rule-equity" value="' + esc(rule.equityMode === "amount" ? rule.equity ?? "" : "") + '">') +
        '</div><div id="rule-equity-percent-field"' + (downsideMode === "percent" ? "" : " hidden") + '>' +
          field("从最高权益回落（%）", '<input type="number" min="0.01" max="100" step="any" id="rule-equity-percent" value="' + esc(rule.equityMode === "percent" ? rule.equity ?? "" : "") + '">') +
        '</div>' +
        '</div><p class="hint">上涨留空关闭。按上次提醒基准计算的规则，会在触发后更新基准。</p>' +
        '<p id="equity-alert-levels" class="hint" aria-live="polite"></p>' +
        '<h2>权益短时波动</h2><div class="rule-actions">' +
        check("enable-volatility", "on", Boolean(rule.equityVolatility), "启用短时波动提醒") + '</div><div class="rule-thresholds">' +
        field("观察窗口（分钟）", '<input id="volatility-minutes" type="number" min="5" max="120" step="1" required value="' + esc(volatility.minutes) + '">') +
        field("涨跌达到（%）", '<input id="volatility-threshold" type="number" min="0.01" max="100" step="any" required value="' + esc(volatility.threshold) + '">') +
        '</div><p class="hint">监控「我的钱包」的总权益，上涨和下跌使用同一阈值。开启后，先积累一个观察窗口的数据。</p>' +
        '<h2>总杠杆提醒</h2><div class="rule-actions">' +
        check("enable-leverage", "on", Boolean(rule.leverageAlert), "启用总杠杆提醒") + '</div><div class="rule-thresholds">' +
        field("超过（倍）", '<input id="leverage-threshold" type="number" min="0.01" max="1000" step="any" required value="' +
          esc(rule.leverageAlert ?? leverageAlertDefault) + '">') +
        '</div><p class="hint">多仓和空仓的名义价值加总，再除以账户总权益。</p>' +
        '<h2>其他仓位提醒</h2><div class="rule-thresholds">' +
        field("合约净浮亏达到（USD）", '<input type="number" min="0.01" max="1000000000000" step="any" id="rule-loss" value="' + esc(rule.loss ?? "") + '">') +
        field("距离强平还剩（%）", '<input type="number" min="0.01" max="100" step="any" id="rule-gap" value="' + esc(rule.gap ?? "") + '">') + '</div>' +
        '<p class="hint">净浮亏统计默认合约市场。强平距离提醒依据 Hyperliquid 提供的强平价。留空关闭对应提醒。</p>' +
        '<h2>分级风险预警</h2><div class="rule-thresholds">' +
        Object.entries(riskFields).map(([key, [label, max, integer]]) => field(label, '<input id="risk-' + key +
          '" type="number" min="' + (integer ? 1 : 0.01) + '" max="' + max + '" step="' + (integer ? "1" : "any") +
          '" value="' + esc(rule.advancedRisk?.[key] ?? "") + '">')).join("") +
        field("重复提醒冷却（分钟）", '<input id="risk-cooldown" type="number" min="1" max="1440" step="1" value="' +
          esc(rule.advancedRisk?.cooldown ?? 15) + '">') + '</div>' +
        '<p class="hint">作用于我的钱包及其全部合约市场。保证金占用按合约保证金合计除以账户总权益计算。今日净亏损从 UTC+8 零点起算。留空关闭对应提醒。</p>' +
        '<h2>锁屏通知隐私</h2>' + check("push-private", "on", rule.pushPrivate, "在系统通知中隐藏提醒详情") +
        '<p class="hint">启用后，打开提醒记录可查看币种、金额和仓位。</p>' +
        button("save-rules", "保存规则") + syncFragment()) +
      panel('<h2>后台通知</h2><p class="hint" id="cloud-scan-note" aria-live="polite">正在读取云端检查状态…</p>' +
        '<p class="hint" id="push-delivery-note" aria-live="polite"></p><p class="hint" id="push-note">正在检查本机通知能力…</p><div id="push-controls" class="workspace-toolbar" hidden>' +
        button("push-enable", "开启本机通知") + button("push-test", "发测试通知") + button("push-disable", "关闭本机通知") + '</div><span id="push-feedback" class="status-inline" role="status"></span>') +
      panel('<div class="inline-row"><h2>提醒记录</h2>' + button("reload-inbox", "刷新") + '</div>' +
        '<div class="workspace-toolbar">' + field("提醒类型", '<select id="inbox-kind">' +
          Object.entries(inboxLabels).map(([key, label]) => choose(key, inboxKind, label)).join("") + '</select>') +
          check("inbox-unread", "on", inboxUnread, "只看未读") + '</div><div id="alert-inbox">' + tip("正在读取…") +
        '</div><span id="inbox-feedback" class="status-inline" role="status"></span>' + button("inbox-more", "加载更多"));
    $("inbox-more").hidden = true;
    updateNotificationPreview();
    refreshEquityLevels();
    refreshCloudHealth();
    refreshPushControls();
    inbox();
  }

  async function refreshEquityLevels() {
    const note = $("equity-alert-levels");
    if (!siteRuntime || !note) return;
    try {
      const levels = await request("/api/equity-alert-levels");
      if (!note.isConnected) return;
      if (!levels.hasWallet) {
        note.textContent = "先在「钱包」设置我的钱包。";
        return;
      }
      const { change, floor } = levels;
      if (!change && !floor) { note.textContent = "已保存的基准涨跌和下跌提醒已关闭。"; return; }
      const lines = [];
      if (change) {
        if (change.baseline === null) lines.push("等待云端记录基准");
        else {
          lines.push("当前基准 " + money(change.baseline));
          if (change.up !== null) lines.push("上涨提醒线 " + money(change.up));
          if (change.down !== null) lines.push("下跌提醒线 " + money(change.down));
        }
      }
      if (floor) {
        if (floor.peakMode) lines.push(floor.peak === null ? "等待云端记录最高权益" : "最高权益 " + money(floor.peak));
        if (floor.down !== null) lines.push("下跌提醒线 " + money(floor.down));
      }
      note.textContent = lines.join(" · ");
    } catch {
      if (note.isConnected) note.textContent = "暂时无法读取已保存规则的基准。";
    }
  }

  function renderInbox(el) {
    if (!inboxItems.length) {
      el.innerHTML = tip(inboxUnread ? "这类提醒没有未读记录。" :
        inboxKind !== "all" ? "暂无这类提醒。" : "暂无提醒。保存规则后，触发的消息会记录在这里。");
    } else {
      let currentDay;
      const rows = inboxItems.map(item => {
        const date = inboxDay.format(item.time);
        const heading = date !== currentDay ? '<h3 class="inbox-date">' + esc(date) + '</h3>' : '';
        currentDay = date;
        const kind = inboxLabels[item.id.split(":", 1)[0]] ?? "提醒";
        const receipt = item.readAt === null
          ? ' <button class="quiet-link" type="button" data-inbox-id="' + esc(item.id) + '">标为已读</button>'
          : ' <span class="subtle">已读</span>';
        const risk = riskLabels[item.details?.level];
        const link = typeof item.details?.path === "string" && item.details.path.startsWith("/?wallet=")
          ? '<a class="quiet-link" href="' + esc(item.details.path) + '">' + (item.details.path.includes("&position=") ? "查看仓位" : "查看钱包") + '</a>' : "";
        return heading + '<article class="inbox-item"><div class="inbox-meta"><time datetime="' + new Date(item.time).toISOString() + '">' +
          esc(inboxClock.format(item.time)) + '</time><span class="tag">' + esc(kind) + '</span>' +
          (risk ? '<span class="tag risk-' + item.details.level + '">' + esc(risk) + '</span>' : "") +
          receipt + link + '</div><div class="alert-body">' +
          (item.title ? '<strong>' + esc(item.title) + '</strong><br>' : '') + esc(item.body) + '</div></article>';
      });
      el.innerHTML = rows.join("");
    }
    $("inbox-more").hidden = !inboxNext;
  }

  async function inbox({ append = false, automatic = false } = {}) {
    const el = $("alert-inbox");
    if (!el || (automatic && (inboxExpanded || $("inbox-more").disabled || el.contains(document.activeElement))) ||
        (append && !inboxNext)) return;
    if (!siteRuntime) { el.innerHTML = tip("请在同步版网页查看提醒记录。"); return; }
    const token = ++inboxRequest;
    const more = $("inbox-more");
    more.disabled = true;
    const query = new URLSearchParams({ kind: inboxKind });
    if (inboxUnread) query.set("unread", "1");
    if (append) {
      query.set("before", inboxNext.time);
      query.set("event", inboxNext.id);
    }
    try {
      const response = await request("/api/inbox?" + query);
      if (!el.isConnected || token !== inboxRequest) return;
      inboxExpanded = append;
      inboxNext = response.next;
      inboxItems = append ? [...inboxItems, ...response.items] : response.items;
      $("inbox-feedback").textContent = "";
      renderInbox(el);
    } catch {
      if (el.isConnected && token === inboxRequest) $("inbox-feedback").textContent = "提醒记录暂时无法读取，请刷新重试。";
    } finally {
      if (token === inboxRequest) more.disabled = false;
    }
  }

  async function markInbox(buttonNode) {
    const el = $("alert-inbox");
    buttonNode.disabled = true;
    const id = buttonNode.dataset.inboxId;
    try {
      await request("/api/inbox/read", "PUT", { id });
      if (!el.isConnected) return;
      inboxItems = inboxUnread ? inboxItems.filter(item => item.id !== id) :
        inboxItems.map(item => item.id === id ? { ...item, readAt: Date.now() } : item);
      renderInbox(el);
    } catch {
      if (el.isConnected) $("inbox-feedback").textContent = "暂时无法标为已读，请重试。";
      buttonNode.disabled = false;
    }
  }

  async function refreshCloudHealth() {
    const note = $("cloud-scan-note");
    if (!siteRuntime || !note) return;
    try {
      const { cloud } = await request("/api/alert-health");
      if (!note.isConnected) return;
      note.textContent = cloud
        ? "最近云端检查：" + formatting.format(cloud.time) +
          (cloud.failures ? " · " + cloud.failures + " 项数据读取异常" : " · 已检查 " + cloud.checked + " 项")
        : "暂无云端检查记录。";
    } catch {
      if (note.isConnected) note.textContent = "暂时无法读取云端检查状态。";
    }
  }

  const pushSupported = () => siteRuntime && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  async function refreshPushControls() {
    const el = $("push-note");
    if (!el) return;
    try {
      if (!pushSupported()) {
        el.textContent = siteRuntime ? "iPhone 请用 Safari 将网页加入主屏幕，从图标打开后开启通知。" : "手机推送需从同步版网页启用。";
        return;
      }
      pushConfig ||= await request("/api/push-config");
      if (!el.isConnected) return;
      if (!pushConfig.publicKey) { el.textContent = "推送服务暂未就绪。"; return; }
      pushRegistration ||= (await ui.registration) ?? await navigator.serviceWorker.register("/sw.js");
      if (!el.isConnected) return;
      const subscription = await pushRegistration.pushManager.getSubscription();
      const status = subscription ? await request("/api/push-status", "POST", { endpoint: subscription.endpoint }) : {};
      const enabled = status.enabled;
      if (!el.isConnected) return;
      const delivery = $("push-delivery-note");
      const previous = status.push;
      const descriptions = { sent: "推送服务已接收", retry: "服务限流，等待重试", expired: "订阅已过期", failed: "推送提交失败" };
      delivery.textContent = previous ? "本机最近" + (previous.test ? "测试" : "提醒") + "推送：" +
        formatting.format(previous.time) + " · " + descriptions[previous.state] :
        enabled ? "本机暂无推送提交记录。" : "";
      el.textContent = enabled ? "本机已开启通知。关闭看板后，云端仍会监听成交并推送提醒。" :
        "每台设备需单独开启通知。iPhone 或 iPad 请从主屏幕图标打开后开启。";
      $("push-controls").hidden = false;
      $("push-enable").hidden = Boolean(enabled);
      $("push-disable").hidden = !enabled;
      $("push-test").hidden = !enabled;
    } catch {
      if (el.isConnected) el.textContent = "浏览器通知暂时无法准备，请从站点首页重新打开。";
    }
  }

  let sendingTest = false;
  async function devicePush(action) {
    const preview = action === "preview";
    const testing = preview || action === "test";
    const message = $(preview ? "push-preview-feedback" : "push-feedback");
    if (testing && sendingTest) return;
    if (!pushRegistration || !pushConfig?.publicKey) {
      message.textContent = "请先在下方开启本机通知。";
      return;
    }
    const previewSettings = preview ? notificationPreviewSettings() : null;
    const testSettings = action === "test" ? tradeNotificationSettings() : null;
    const sendButton = testing ? $(preview ? "push-preview" : "push-test") : null;
    if (sendButton) {
      sendingTest = true;
      sendButton.disabled = true;
      message.textContent = "正在发送…";
    }
    try {
      if (action === "enable") {
        const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
        if (permission !== "granted") {
          message.textContent = "允许浏览器和系统发送通知后，请重试。";
          return;
        }
        const raw = atob(pushConfig.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
        const key = Uint8Array.from(raw, char => char.charCodeAt(0));
        const existing = await pushRegistration.pushManager.getSubscription();
        const subscription = existing ?? await pushRegistration.pushManager.subscribe({ applicationServerKey: key, userVisibleOnly: true });
        try { await request("/api/push-device", "POST", subscription.toJSON()); }
        catch (error) { if (!existing) await subscription.unsubscribe(); throw error; }
        message.textContent = "本机已开启通知。可以发一条测试通知。";
      } else {
        const subscription = await pushRegistration.pushManager.getSubscription();
        if (!subscription) throw new Error("本机还没有开启通知");
        if (action === "disable") {
          await request("/api/push-device", "DELETE", { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
          message.textContent = "已关闭本机通知。";
        } else {
          await request("/api/push-test", "POST", {
            endpoint: subscription.endpoint,
            ...(preview ? { preview: previewSettings } : testSettings),
          });
          message.textContent = "已提交推送，请查看本机通知。";
        }
      }
    } catch (error) {
      message.textContent = error.name === "NotAllowedError" ? "本机通知权限未开启，请检查系统或浏览器通知设置。" : error.message;
    } finally {
      if (sendButton) {
        sendingTest = false;
        sendButton.disabled = false;
      }
    }
    refreshPushControls();
  }

  function recordNavigation() {
    return '<nav class="record-tabs" aria-label="记录分类">' +
      [["activity", "交易动态"], ["pnl", "盈亏账本"]].map(([view, label]) =>
        '<button class="btn" type="button" data-record-view="' + view + '" aria-pressed="' +
          String(active === view) + '">' + label + '</button>').join("") + '</nav>';
  }

  function minePage() {
    const actions = '<div class="mine-actions">' + button("goto-wallets", "钱包管理") +
      (siteRuntime ? '<a class="btn" href="/account">账户设置</a><form method="post" action="/logout"><button class="btn" type="submit">退出登录</button></form>' : "") +
      '</div>';
    viewRoot.innerHTML = '<div class="workspace-heading"><h1>我的</h1></div>' + panel(actions);
  }

  function render() {
    const token = ++sequence;
    const dashboardView = active === "over" || active === "positions";
    dashboard.hidden = !dashboardView;
    dashboard.dataset.section = active;
    ui.syncOverview();
    $("page-title").textContent = active === "positions" ? "持仓" : "钱包总览";
    $("mobile-shortcuts").hidden = !dashboardView;
    viewRoot.hidden = dashboardView;
    if (dashboardView) { if (active === "over") renderComparison(); return; }
    ({ wallets: walletsPage, activity: activityPage, pnl: pnlPage, alerts: alertPage, mine: minePage })[active](token);
    if (active === "activity" || active === "pnl") viewRoot.insertAdjacentHTML("afterbegin", recordNavigation());
    syncStatus();
  }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const visiblePage = () => dashboard.hidden ? viewRoot : dashboard;
  const mobileIndex = view => mobileViews.indexOf(mobileViewOf(view));
  let pageAnimation;
  let draggedPage;
  let dragOffset = 0;

  function clearPageMotion() {
    pageAnimation?.cancel();
    pageAnimation = null;
    draggedPage?.style.removeProperty("transform");
    draggedPage = null;
    dragOffset = 0;
  }

  function slidePage(offset, opacity = 1, duration = 240) {
    if (reducedMotion.matches) return;
    pageAnimation = visiblePage().animate([
      { transform: `translateX(${offset}px)`, opacity },
      { transform: "translateX(0)", opacity: 1 },
    ], { duration, easing: "cubic-bezier(.22, .75, .25, 1)", fill: "backwards" });
  }

  function previewPageSwipe(distance) {
    if (distance === null) {
      if (!draggedPage) return;
      const offset = dragOffset;
      clearPageMotion();
      slidePage(offset, 1, 160);
      return;
    }
    if (reducedMotion.matches) return;
    if (!draggedPage) {
      clearPageMotion();
      draggedPage = visiblePage();
    }
    const direction = distance < 0 ? 1 : -1;
    const adjacent = mobileViews[mobileIndex(active) + direction];
    dragOffset = Math.sign(distance) * Math.min(adjacent ? 72 : 16, Math.abs(distance) * (adjacent ? .55 : .22));
    draggedPage.style.transform = `translateX(${dragOffset}px)`;
  }
  reducedMotion.addEventListener("change", clearPageMotion);

  function show(next, changeHash = true, animate = false) {
    if (next === "compare") {
      comparison.open = true;
      next = "over";
      changeHash = true;
    }
    if (!["over", "positions", "wallets", "activity", "pnl", "alerts", "mine"].includes(next)) next = "over";
    const changed = active !== next;
    const slideDirection = animate ? Math.sign(mobileIndex(next) - mobileIndex(active)) : 0;
    clearPageMotion();
    active = next;
    const desktopView = next === "positions" ? "over" : next === "mine" ? "wallets" : next;
    const mobileView = mobileViewOf(next);
    for (const button of $("workspace-tabs").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === desktopView));
    for (const button of mobileTabs.querySelectorAll("button")) {
      if (button.dataset.view === mobileView) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (changeHash && location.hash !== (next === "over" ? "" : "#" + next)) {
      try { history.replaceState(null, "", location.pathname + location.search + (next === "over" ? "" : "#" + next)); } catch {}
    }
    if (changed) window.scrollTo(0, 0);
    render();
    if (next === "over" || next === "positions") ui.resumeOverview();
    if (slideDirection) slidePage(slideDirection * 72, .48);
  }

  comparison.addEventListener("toggle", () => {
    if (!comparison.open) comparisonContent.replaceChildren();
    else if (active === "over" && !comparisonContent.hasChildNodes()) renderComparison();
  });
  comparisonContent.addEventListener("change", ({ target }) => {
    if (target.name === "compare-wallet") {
      compareAddresses = [...comparisonContent.querySelectorAll('[name="compare-wallet"]:checked')].map(item => item.value).slice(0, 3);
      ui.store("comparison-wallets", compareAddresses);
    } else if (target.id === "compare-filter") compareFilter = target.value;
    else return;
    renderComparison();
  });
  comparisonContent.addEventListener("click", event => {
    if (event.target.closest("button")?.id !== "refresh-comparison") return;
    briefCache.clear();
    fillsCache.clear();
    renderComparison();
  });
  for (const nav of [$("workspace-tabs"), mobileTabs]) {
    nav.addEventListener("click", event => {
      const next = event.target.closest("button")?.dataset.view;
      const onMobile = nav === mobileTabs;
      if (next) show(next === "activity" && onMobile && active === "pnl" ? "pnl" : next, true, onMobile);
    });
  }
  enablePageSwipe(document.body, {
    currentView: () => active,
    canStart(target) {
      if (!mobileTabs.getClientRects().length || document.querySelector("dialog[open]")) return false;
      if (mobileTabs.contains(target)) return true;
      return (target === document.body || target.closest("#dashboard, #workspace-view")) &&
        !target.closest(swipeContentExclusions);
    },
    preview: previewPageSwipe,
    move(direction) {
      const next = mobileViews[mobileIndex(active) + direction];
      if (!next) return false;
      show(next, true, true);
      return true;
    },
  });
  $("wallet-prev").addEventListener("click", () => stepWallet(-1));
  $("wallet-next").addEventListener("click", () => stepWallet(1));
  document.addEventListener("hyper-wallet-changed", renderMobileWallet);
  const swipe = $("wallet-swipe");
  let swipeStart;
  swipe.addEventListener("touchstart", event => {
    swipeStart = event.touches.length === 1 ? event.touches[0] : null;
  }, { passive: true });
  swipe.addEventListener("touchend", event => {
    if (!swipeStart || !event.changedTouches.length) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - swipeStart.clientX;
    const dy = touch.clientY - swipeStart.clientY;
    swipeStart = null;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > 1.5 * Math.abs(dy)) stepWallet(dx < 0 ? 1 : -1);
  }, { passive: true });
  swipe.addEventListener("touchcancel", () => { swipeStart = null; });
  for (const id of ["toggle-quick", "mobile-quick"]) {
    $(id).addEventListener("click", () => { update({ ...profile, quick: !profile.quick }); });
  }
  viewRoot.addEventListener("click", event => {
    const selected = event.target.closest("button");
    if (!selected) return;
    if (selected.dataset.recordView) { show(selected.dataset.recordView); return; }
    if (selected.dataset.inboxId) { markInbox(selected); return; }
    const address = selected.dataset.address;
    const action = selected.dataset.watchAction;
    if (action === "observe") { ui.observe(address); show("over"); }
    if (action === "edit") { editing = address; render(); $("watch-name").focus(); }
    if (action === "pin") update({ ...profile, wallets: profile.wallets.map(wallet =>
      wallet.address === address ? { ...wallet, pinned: !wallet.pinned } : wallet) });
    if (action === "favorite") update({ ...profile, wallets: profile.wallets.map(wallet =>
      wallet.address === address ? { ...wallet, favorite: !wallet.favorite } : wallet) });

    switch (selected.id) {
      case "goto-wallets": show("wallets"); break;
      case "save-watch": saveWallet(); break;
      case "cancel-edit": editing = ""; render(); break;
      case "remove-watch": {
        const target = editing;
        editing = "";
        update({ ...profile, wallets: profile.wallets.filter(wallet => wallet.address !== target) });
        break;
      }
      case "refresh-view": briefCache.clear(); fillsCache.clear(); ledgerPages = []; render(); break;
      case "ledger-prev": ledgerPages.pop(); render(); break;
      case "ledger-next": if (ledgerNext) { ledgerPages.push(ledgerNext); render(); } break;
      case "use-cloud": keepVersion(true); break;
      case "use-device": keepVersion(false); break;
      case "reload-inbox": inbox(); break;
      case "inbox-more": inbox({ append: true }); break;
      case "push-enable": devicePush("enable"); break;
      case "push-disable": devicePush("disable"); break;
      case "push-test": devicePush("test"); break;
      case "push-preview": devicePush("preview"); break;
      case "save-rules": {
        const downsideMode = $("rule-equity-downside").value;
        const equityMode = downsideMode === "percent" ? "percent" : "amount";
        const downsideInput = $(downsideInputIds[downsideMode]);
        const volatilityEnabled = viewRoot.querySelector('[name="enable-volatility"]').checked;
        const leverageEnabled = viewRoot.querySelector('[name="enable-leverage"]').checked;
        const riskKeys = [...Object.keys(riskFields), "cooldown"];
        const riskInputs = riskKeys.map(key => $("risk-" + key));
        const inputs = [$("rule-loss"), $("rule-gap"), $("equity-change-up"), downsideInput, ...riskInputs];
        if (volatilityEnabled) inputs.push($("volatility-minutes"), $("volatility-threshold"));
        if (leverageEnabled) inputs.push($("leverage-threshold"));
        if (!inputs.filter(Boolean).every(input => input.reportValidity())) break;
        const equityChangeAlert = readEquityChangeRule();
        if (equityChangeAlert) {
          const previous = profile.rules.equityChangeAlert;
          const unchanged = previous?.up === equityChangeAlert.up && previous?.down === equityChangeAlert.down;
          equityChangeAlert.id = unchanged && previous.id ? previous.id : crypto.randomUUID();
        }
        update({ ...profile, rules: {
          actions: [...viewRoot.querySelectorAll('[name="rule-action"]:checked')].map(item => item.value),
          ...tradeNotificationSettings(), equityChangeAlert,
          equityVolatility: volatilityEnabled ? volatilityFields() : null,
          leverageAlert: leverageEnabled ? $("leverage-threshold").value : null,
          equityMode, equity: downsideMode === "rolling" ? null : downsideInput?.value, equityTrackingId: profile.rules.equityTrackingId,
          loss: $("rule-loss").value, gap: $("rule-gap").value,
          advancedRisk: Object.fromEntries(riskKeys.map((key, index) => [key, riskInputs[index].value])),
          pushPrivate: viewRoot.querySelector('[name="push-private"]').checked,
        } });
        break;
      }
    }
  });
  viewRoot.addEventListener("input", ({ target }) => {
    if (target.id === "preview-wallet-name") {
      previewWalletName = target.value;
      ui.store("notification-preview-wallet", previewWalletName);
    }
    if (["preview-wallet-name", "equity-change-up", "volatility-minutes", "volatility-threshold",
      "leverage-threshold", ...Object.values(downsideInputIds)].includes(target.id)) updateNotificationPreview();
  });
  viewRoot.addEventListener("change", ({ target }) => {
    if (target.name === "favorites-only") { favoritesOnly = target.checked; render(); return; }
    if (target.id === "inbox-kind" || target.name === "inbox-unread") {
      inboxKind = $("inbox-kind").value;
      inboxUnread = viewRoot.querySelector('[name="inbox-unread"]').checked;
      inboxNext = null;
      $("alert-inbox").innerHTML = tip("正在读取…");
      $("inbox-more").hidden = true;
      inbox();
      return;
    }
    if (target.id === "notification-preview-type") previewType = target.value;
    if (target.name === "notification-field" || ["notification-preview-type", "notification-position-unit"].includes(target.id)) {
      updateNotificationPreview();
      return;
    }
    switch (target.id) {
      case "rule-equity-downside":
        for (const mode of Object.keys(downsideInputIds)) $("rule-equity-" + mode + "-field").hidden = target.value !== mode;
        updateNotificationPreview();
        return;
      case "wallet-group-filter": watchGroup = target.value; break;
      case "activity-wallet": activityAddress = target.value; break;
      case "event-filter": eventFilter = target.value; break;
      case "pnl-wallet": pnlAddress = target.value; ledgerPages = []; break;
      case "pnl-mode": pnlMode = target.value; ledgerPages = []; ui.store("pnl-mode", pnlMode); break;
      case "ledger-view": ledgerView = target.value; ledgerPages = []; break;
      case "ledger-period": ledgerPeriod = target.value; ledgerPages = []; ui.store("ledger-period", ledgerPeriod); break;
      case "pnl-range": range = target.value; break;
      default: return;
    }
    render();
  });

  if (matchMedia("(display-mode: standalone)").matches && ui.load("workspace", null) === null) profile.quick = true;
  persistLocal();
  show(location.hash.slice(1), false);
  window.addEventListener("hashchange", () => show(location.hash.slice(1), false));
  if (siteRuntime) {
    sync();
    setInterval(() => { if (!document.hidden) sync(dirty); }, 45000);
  }
  const foregroundAlertInterval = 15000;
  let checkingAlerts = false;
  async function checkWhileOpen() {
    if (!siteRuntime || document.hidden || !navigator.onLine || dirty || checkingAlerts) return;
    const { actions, equity, loss, gap, equityChangeAlert, equityVolatility, leverageAlert, advancedRisk } = profile.rules;
    const applies = (actions.length && profile.wallets.some(wallet => wallet.notify)) ||
      (own() && (equity || loss || gap || equityChangeAlert || equityVolatility || leverageAlert || advancedRisk));
    if (!applies) return;
    checkingAlerts = true;
    try {
      await request("/api/run-alerts", "POST");
      if (active === "alerts") { inbox({ automatic: true }); refreshEquityLevels(); }
    } catch {
      // The next check retries through the same endpoint.
    } finally {
      checkingAlerts = false;
    }
  }
  if (siteRuntime) setInterval(checkWhileOpen, foregroundAlertInterval);
  setInterval(() => { if (!document.hidden && navigator.onLine && active === "wallets") loadCards(); }, 10000);
  setInterval(() => {
    if (document.hidden || !navigator.onLine) return;
    if (active === "activity" && !viewRoot.contains(document.activeElement)) render();
    if (active === "over" && comparison.open && !comparisonContent.contains(document.activeElement)) renderComparison();
    if (active === "alerts") { inbox({ automatic: true }); refreshEquityLevels(); refreshCloudHealth(); refreshPushControls(); }
  }, 45000);
  return { refreshComparison: renderComparison, refreshPrivacy: () => { if (active === "pnl") render(); else renderComparison(); }, openWallets: () => { show("wallets"); $("watch-address").focus(); } };
}
