import { addressOf, actionLabels, cleanProfile, day, gapToLiquidation, metricsFor, portfolioBrief, positionChanges, walletLimit, walletName } from "./analytics.js";
import { info, parsePortfolio, parsePositions } from "./market.js";

const $ = id => document.getElementById(id);
const siteRuntime = document.documentElement.dataset.runtime === "site";
const formatting = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
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
    ...(data !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || "请求失败（" + response.status + "）"), { status: response.status, payload });
  return payload;
}

function table(columns, rows) {
  if (!rows.length) return tip("暂无持仓");
  return '<div class="data-scroll"><table class="detail-table"><thead><tr>' + columns.map(name => '<th scope="col">' + esc(name) + '</th>').join("") +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map((cell, i) => '<td data-label="' + esc(columns[i]) + '">' + cell + '</td>').join("") + '</tr>').join("") + '</tbody></table></div>';
}

export function setupWorkspace(ui) {
  const viewRoot = $("workspace-view");
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
  let compareAddress = "";
  let activityAddress = "";
  let pnlAddress = "";
  let range = "7";
  let eventFilter = "all";
  let pushConfig, pushRegistration;
  const briefCache = new Map();
  const fillsCache = new Map();

  async function recentFills(address) {
    const saved = fillsCache.get(address);
    if (saved && Date.now() - saved.at < 40000) return saved.rows;
    const rows = await info("userFillsByTime", address, undefined, { startTime: Date.now() - 7 * day, aggregateByTime: true });
    if (!Array.isArray(rows)) throw new Error("成交记录格式异常");
    fillsCache.set(address, { at: Date.now(), rows });
    return rows;
  }

  const briefOnly = async address => {
    const cached = briefCache.get(address);
    if (cached && Date.now() - cached.at < 40000) return cached;
    const [history, positions] = await Promise.allSettled([
      info("portfolio", address).then(parsePortfolio),
      info("clearinghouseState", address).then(raw => parsePositions([["", raw]])),
    ]);
    if (history.status === "rejected" && positions.status === "rejected") throw history.reason;
    const next = { at: Date.now(), history: history.value ?? null, positions: positions.value ?? null };
    briefCache.set(address, next);
    return next;
  };

  const persistLocal = () => {
    ui.store("workspace", profile);
    ui.store("workspace-pending", dirty);
    document.body.classList.toggle("quick-mode", profile.quick);
    $("toggle-quick").setAttribute("aria-pressed", String(profile.quick));
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
        syncMessage = "同步暂时不可用，设置保存在本机";
        return;
      }
    } finally {
      busy = false;
      syncStatus();
    }
    if (dirty && !conflict) sync(true);
  }

  function update(next) {
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
        const details = positions ? (positions.length ? "主市场 " + longs + " 多 / " + shorts + " 空" : "主市场无持仓") : "持仓暂不可用";
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
    const list = [...profile.wallets].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.role === "mine") - Number(a.role === "mine"));
    const groups = [...new Set(list.map(row => row.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh"));
    if (!groups.includes(watchGroup)) watchGroup = "";
    const groupPicker = groups.length ? '<div class="workspace-toolbar">' +
      field("分组筛选", '<select id="wallet-group-filter">' + choose("", watchGroup, "全部分组") +
      groups.map(group => choose(group, watchGroup, group)).join("") + '</select>') + '</div>' : "";
    const wallet = selectedWallet(editing);
    const prefill = wallet?.address ?? (ui.session().user && !selectedWallet(ui.session().user) ? ui.session().user : "");
    const cards = list.filter(row => !watchGroup || row.group === watchGroup).map(row => {
      const short = row.address.slice(0, 6) + "…" + row.address.slice(-4);
      return '<article class="watch-card ' + (row.role === "mine" ? "own" : "") + '"><div class="watch-header"><span class="watch-title"><strong>' +
        esc(walletName(row)) + '</strong><span class="tag ' + row.role + '">' + (row.role === "mine" ? "我的钱包" : "关注") +
        '</span></span><button class="quiet-link" type="button" data-watch-action="pin" aria-pressed="' + row.pinned + '" data-address="' + row.address + '">' +
        (row.pinned ? "取消置顶" : "置顶") + '</button></div><p class="watch-meta" title="' + row.address + '">' + esc(short + (row.group ? " · " + row.group : "")) +
        (row.notify ? " · 动态提醒已勾选" : "") + '</p><div data-card="' + row.address + '" class="card-readout"><p class="watch-meta">正在读取余额和仓位…</p></div>' +
        '<div class="inline-row"><button type="button" class="btn" data-watch-action="observe" data-address="' + row.address + '">观察</button>' +
        '<button type="button" class="btn" data-watch-action="edit" data-address="' + row.address + '">编辑</button></div></article>';
    }).join("");
    viewRoot.innerHTML = titled("钱包列表", "同一页查看自己的钱包和关注对象。") +
      groupPicker + (cards ? '<section class="watch-cards">' + cards + '</section>' : "") +
      panel('<h2>' + (wallet ? "编辑钱包" : "添加钱包") + '</h2><div class="wallet-editor">' +
        field("公开地址", '<input id="watch-address" maxlength="42" placeholder="0x…" autocomplete="off" spellcheck="false" value="' + esc(prefill) + '"' + (wallet ? " readonly" : "") + '>', "address-field") +
        field("备注", '<input id="watch-name" maxlength="28" placeholder="例如 我的主账户" value="' + esc(wallet?.name ?? "") + '">') +
        field("分组", '<input id="watch-group" maxlength="18" placeholder="例如 ETH" value="' + esc(wallet?.group ?? "") + '">') +
        field("用途", '<select id="watch-role">' + choose("watch", wallet?.role ?? "watch", "关注") + choose("mine", wallet?.role ?? "watch", "我的钱包") + '</select>') +
        button("save-watch", wallet ? "保存" : "添加") + '</div>' +
        '<div class="inline-row">' + check("watch-notify", "on", wallet?.notify, "接收这个钱包的仓位变动") +
        (wallet ? '<div>' + button("cancel-edit", "取消编辑") + ' ' + button("remove-watch", "移除") + '</div>' : '') + '</div>' +
        '<span id="wallet-message" class="status-inline" role="status"></span>' + syncFragment());
    loadCards();
  }

  function saveWallet() {
    const address = addressOf($("watch-address").value);
    const message = $("wallet-message");
    if (!address) { message.textContent = "请输入 42 个字符的 0x 钱包地址。"; $("watch-address").focus(); return; }
    if (!editing && selectedWallet(address)) { message.textContent = "这个钱包已在列表中。"; return; }
    if (!editing && profile.wallets.length >= walletLimit) { message.textContent = "已达到 " + walletLimit + " 个钱包。"; return; }
    const role = $("watch-role").value;
    const row = {
      address, role, name: $("watch-name").value, group: $("watch-group").value,
      pinned: selectedWallet(address)?.pinned ?? false, notify: viewRoot.querySelector('[name="watch-notify"]').checked,
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
        button("refresh-view", "刷新") + '</div><div id="activity-data">' + tip("正在读取成交记录…") + '</div>'));
    if (!activityAddress) return;
    recentFills(activityAddress).then(raw => {
      if (token !== sequence) return;
      const rows = positionChanges(raw).filter(row => eventFilter === "all" || row.action === eventFilter).reverse();
      $("activity-data").innerHTML = (raw.length >= 2000 ? '<p class="hint">成交量较大，已达到接口的单次返回上限。</p>' : '') +
        (rows.length ? '<div class="timeline">' + rows.slice(0, 100).map(row => {
          const direction = (row.end || row.start) > 0 ? "多" : "空";
          return '<div class="timeline-row"><time>' + esc(formatting.format(row.time)) + '</time><strong>' + esc(row.coin) +
            '</strong><div><span class="tag">' + esc(actionLabels[row.action] + " " + direction) + '</span> ' +
            esc(quantity(row.size) + " @ " + money(row.price)) + (row.cut === null ? "" : " · " + esc(ui.percent(row.cut))) + '</div></div>';
        }).join("") + '</div>' + (rows.length > 100 ? '<p class="hint">显示最近 100 条匹配记录。</p>' : '') : tip("这个时段没有匹配的合约仓位变动。"));
    }).catch(error => { if (token === sequence) $("activity-data").innerHTML = tip("无法获取成交记录。 " + (error.status ? "HTTP " + error.status : (error.timeout ? "请求超时" : "连接或响应异常"))); });
  }

  function comparisonPage(token) {
    const mine = own();
    const watch = profile.wallets.filter(row => row.address !== mine?.address);
    compareAddress = watch.some(row => row.address === compareAddress) ? compareAddress : watch[0]?.address;
    viewRoot.innerHTML = titled("仓位对比", "对比 Hyperliquid 主市场快照。仓位占比按名义价值 ÷ 账户权益计算。") +
      (!mine || !compareAddress ? noWallet("给一个地址设置「我的钱包」，再添加关注钱包。") :
        panel('<div class="workspace-toolbar">' + field("跟谁对比", select("compare-wallet", compareAddress, watch), "flex") +
          button("refresh-view", "刷新") + '</div><div id="compare-data">' + tip("正在读取两边仓位…") + '</div>'));
    if (!mine || !compareAddress) return;
    const other = selectedWallet(compareAddress);
    Promise.all([briefOnly(mine.address), briefOnly(other.address), recentFills(other.address).catch(() => null)]).then(([left, right, recent]) => {
      if (token !== sequence) return;
      if (!left.positions || !right.positions) { $("compare-data").innerHTML = tip("其中一个钱包的仓位快照无法读取。"); return; }
      const a = new Map(left.positions.map(row => [row.coin, row]));
      const b = new Map(right.positions.map(row => [row.coin, row]));
      const ae = portfolioBrief(left.history).equity;
      const be = portfolioBrief(right.history).equity;
      const format = (row, equity) => row ? esc((row.size > 0 ? "多" : "空") + " " + quantity(Math.abs(row.size))) +
        '<div class="subtle">' + esc("均价 " + money(row.entry) + " · 占权益 " + ui.percent(equity > 0 && row.value !== null ? row.value / equity * 100 : null)) + '</div>' : "当前无仓";
      const mostRecent = new Map(positionChanges(recent).map(change => [change.coin, change]));
      const recentCloses = [...mostRecent].filter(([coin, change]) => !coin.includes(":") && !b.has(coin) && change.action === "close").map(([coin]) => coin);
      const rows = [...new Set([...a.keys(), ...b.keys(), ...recentCloses])].map(coin => {
        const my = a.get(coin);
        const their = b.get(coin);
        return [esc(coin), format(my, ae), format(their, be), my && their ? (Math.sign(my.size) === Math.sign(their.size) ? "同向" : "反向") : recentCloses.includes(coin) ? "对方近 7 天已平仓" : my ? "仅我持有" : "仅对方持有"];
      });
      $("compare-data").innerHTML = table(["合约", walletName(mine), walletName(other), "方向差异"], rows);
    }).catch(() => { if (token === sequence) $("compare-data").innerHTML = tip("仓位暂时无法读取，请稍后刷新。"); });
  }

  function pnlPage(token) {
    pnlAddress = chooseWallet(pnlAddress);
    viewRoot.innerHTML = titled("盈亏拆分", "按区间汇总成交和资金流水，当前浮盈单独显示。") +
      (!pnlAddress ? noWallet("添加钱包后可查看盈亏拆分。") : panel(
        '<div class="workspace-toolbar">' + field("观察钱包", select("pnl-wallet", pnlAddress, realInputs()), "flex") +
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
      const totals = metricsFor(rows(fills), rows(funding), rows(ledger));
      const positions = brief.value?.positions;
      const floating = positions?.every(row => row.pnl !== null) ? positions.reduce((sum, row) => sum + row.pnl, 0) : null;
      const feeDisplay = totals.fees === null ? "—" : totals.fees.length ? totals.fees.map(([token, value]) => quantity(value) + " " + token).join(" / ") : "0";
      const cards = [["已实现盈亏", money(totals.realized, { signed: true })], ["当前浮盈亏 · 主市场", money(floating, { signed: true })],
        ["成交手续费 · 原币种", feeDisplay], ["资金费 · 接口金额", money(totals.funding, { signed: true })],
        ["净充值提现 · USDC", money(totals.cashFlow, { signed: true })]];
      $("pnl-data").innerHTML = '<div class="readout-grid">' + cards.map(([name, value]) => '<div class="readout"><small>' + esc(name) + '</small><strong>' + esc(value) + '</strong></div>').join("") +
        '</div><p class="hint">已实现盈亏按成交接口的 closedPnl 汇总。净充值提现只统计充值与提现记录。</p>' +
        (totals.truncated ? '<p class="hint">成交达到接口返回上限，金额可能不完整。可选择更短区间。</p>' : '') +
        ([fills, funding, ledger, brief].some(item => item.status === "rejected") ? '<p class="hint">部分数据读取失败，对应项目显示为 —。</p>' : '');
    });
  }

  function riskPage() {
    const session = ui.session();
    const brief = portfolioBrief(session.history);
    const rows = (session.positions ?? []).map(row => {
      const gap = gapToLiquidation(row);
      const danger = gap !== null && gap <= 5;
      const margin = [row.leverage ? quantity(row.leverage) + "×" : "", row.mode === "cross" ? "全仓" : row.mode === "isolated" ? "逐仓" : ""].filter(Boolean).join(" · ");
      return [esc(row.coin), esc((row.size < 0 ? "空" : "多") + " " + quantity(Math.abs(row.size))),
        esc(margin || "—"), esc(money(row.margin)),
        esc(ui.percent(brief.equity > 0 && row.value !== null ? row.value / brief.equity * 100 : null)),
        (danger ? '<span class="danger">' : '<span>') + esc(money(row.liquidation)) + '</span><div class="subtle">' + esc(gap === null ? "暂无距离数据" : "相距 " + ui.percent(gap)) + '</div>'];
    });
    const content = session.positions ? table(["合约", "方向与数量", "杠杆 / 模式", "保证金占用", "名义仓位 / 权益", "预估强平价"], rows) : tip("正在读取持仓…");
    viewRoot.innerHTML = titled("持仓风险", session.user ? "当前观察 " + (selectedWallet(session.user)?.name || session.user.slice(0, 6) + "…" + session.user.slice(-4)) : "当前显示演示仓位。") +
      panel(content + '<p class="hint">预估强平价使用 Hyperliquid 返回的字段。' +
        (session.scope === "main" ? "此快照覆盖主市场。" : "") + '</p>');
  }

  function alertPage() {
    const rule = profile.rules;
    viewRoot.innerHTML = titled("提醒设置", "关注钱包的仓位变动及我的仓位阈值。") +
      panel('<h2>仓位变动</h2><div class="rule-actions">' +
        Object.entries(actionLabels).map(([key, label]) => check("rule-action", key, rule.actions.includes(key), label)).join("") +
        '</div><p class="hint">钱包列表中勾选「接收这个钱包的仓位变动」后适用。</p><h2>我的钱包阈值</h2><div class="rule-thresholds">' +
        field("账户权益低于 USD", '<input type="number" min="0.01" step="any" id="rule-equity" value="' + esc(rule.equity ?? "") + '">') +
        field("主市场浮亏达到 USD", '<input type="number" min="0.01" step="any" id="rule-loss" value="' + esc(rule.loss ?? "") + '">') +
        field("离预估强平价低于 %", '<input type="number" min="0.01" max="100" step="any" id="rule-gap" value="' + esc(rule.gap ?? "") + '">') + '</div>' +
        button("save-rules", "保存规则") + syncFragment()) +
      panel('<h2>本机通知</h2><p class="hint" id="push-note">正在检查本机通知能力…</p><div id="push-controls" class="workspace-toolbar" hidden>' +
        button("push-enable", "开启本机通知") + button("push-test", "发测试通知") + button("push-disable", "关闭本机通知") + '</div><span id="push-feedback" class="status-inline" role="status"></span>') +
      panel('<div class="inline-row"><h2>提醒记录</h2>' + button("reload-inbox", "刷新") + '</div><div id="alert-inbox">' + tip("正在读取…") + '</div>');
    refreshPushControls();
    inbox();
  }

  async function inbox() {
    const el = $("alert-inbox");
    if (!el) return;
    if (!siteRuntime) { el.innerHTML = tip("请在同步版网页查看提醒记录。"); return; }
    try {
      const response = await request("/api/inbox");
      if (!el.isConnected) return;
      el.innerHTML = response.items.length ? '<div class="timeline">' + response.items.map(item =>
        '<div class="timeline-row"><time>' + esc(formatting.format(item.time)) + '</time><span>' + esc(item.body) + '</span></div>').join("") + '</div>' :
        tip("暂无提醒。先保存规则并开启本机通知。");
    } catch {
      if (el.isConnected) el.innerHTML = tip("提醒记录暂时无法读取。");
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
      pushRegistration ||= await navigator.serviceWorker.register("/sw.js");
      if (!el.isConnected) return;
      const subscription = await pushRegistration.pushManager.getSubscription();
      if (!el.isConnected) return;
      el.textContent = subscription ? "本机已订阅浏览器推送。后台按计划检查规则。" :
        "开启后可接收后台提醒。iPhone 从主屏幕图标打开进行授权。";
      $("push-controls").hidden = false;
      $("push-enable").hidden = Boolean(subscription);
      $("push-disable").hidden = !subscription;
      $("push-test").hidden = !subscription;
    } catch {
      if (el.isConnected) el.textContent = "浏览器通知暂时无法准备，请从站点首页重新打开。";
    }
  }

  async function devicePush(action) {
    const message = $("push-feedback");
    if (!pushRegistration || !pushConfig?.publicKey) return;
    try {
      if (action === "enable") {
        const raw = atob(pushConfig.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
        const key = Uint8Array.from(raw, char => char.charCodeAt(0));
        const subscription = await pushRegistration.pushManager.subscribe({ applicationServerKey: key, userVisibleOnly: true });
        try { await request("/api/push-device", "POST", subscription.toJSON()); }
        catch (error) { await subscription.unsubscribe(); throw error; }
        message.textContent = "本机已开启通知。可以发一条测试通知。";
      } else {
        const subscription = await pushRegistration.pushManager.getSubscription();
        if (!subscription) throw new Error("本机还没有开启通知");
        if (action === "disable") {
          await request("/api/push-device", "DELETE", { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
          message.textContent = "已关闭本机通知。";
        } else {
          await request("/api/push-test", "POST", { endpoint: subscription.endpoint });
          message.textContent = "测试通知已提交。";
        }
      }
    } catch (error) {
      message.textContent = error.name === "NotAllowedError" ? "本机通知权限未开启，请检查系统或浏览器通知设置。" : error.message;
    }
    refreshPushControls();
  }

  function render() {
    const token = ++sequence;
    $("dashboard").hidden = active !== "over";
    viewRoot.hidden = active === "over";
    if (active === "over") return;
    ({ wallets: walletsPage, activity: activityPage, compare: comparisonPage, pnl: pnlPage, risk: riskPage, alerts: alertPage })[active](token);
    syncStatus();
  }

  function show(next, changeHash = true) {
    const matched = [...$("workspace-tabs").querySelectorAll("button")].find(el => el.dataset.view === next);
    if (!matched) next = "over";
    active = next;
    for (const button of $("workspace-tabs").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === next));
    if (changeHash && location.hash !== (next === "over" ? "" : "#" + next)) {
      try { history.replaceState(null, "", location.pathname + location.search + (next === "over" ? "" : "#" + next)); } catch {}
    }
    render();
  }

  $("workspace-tabs").addEventListener("click", event => {
    const next = event.target.closest("button")?.dataset.view;
    if (next) show(next);
  });
  $("toggle-quick").addEventListener("click", () => {
    update({ ...profile, quick: !profile.quick });
    show("over");
  });
  viewRoot.addEventListener("click", event => {
    const selected = event.target.closest("button");
    if (!selected) return;
    const address = selected.dataset.address;
    const action = selected.dataset.watchAction;
    if (action === "observe") { ui.observe(address); show("over"); }
    if (action === "edit") { editing = address; render(); $("watch-name").focus(); }
    if (action === "pin") update({ ...profile, wallets: profile.wallets.map(wallet =>
      wallet.address === address ? { ...wallet, pinned: !wallet.pinned } : wallet) });

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
      case "refresh-view": briefCache.clear(); fillsCache.clear(); render(); break;
      case "use-cloud": keepVersion(true); break;
      case "use-device": keepVersion(false); break;
      case "reload-inbox": inbox(); break;
      case "push-enable": devicePush("enable"); break;
      case "push-disable": devicePush("disable"); break;
      case "push-test": devicePush("test"); break;
      case "save-rules":
        update({ ...profile, rules: {
          actions: [...viewRoot.querySelectorAll('[name="rule-action"]:checked')].map(item => item.value),
          equity: $("rule-equity").value, loss: $("rule-loss").value, gap: $("rule-gap").value,
        } });
        break;
    }
  });
  viewRoot.addEventListener("change", ({ target }) => {
    switch (target.id) {
      case "wallet-group-filter": watchGroup = target.value; break;
      case "activity-wallet": activityAddress = target.value; break;
      case "event-filter": eventFilter = target.value; break;
      case "compare-wallet": compareAddress = target.value; break;
      case "pnl-wallet": pnlAddress = target.value; break;
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
  let lastAlertCheck = 0;
  async function checkWhileOpen() {
    if (!siteRuntime || document.hidden || dirty || Date.now() - lastAlertCheck < 22000) return;
    const { actions, equity, loss, gap } = profile.rules;
    const applies = (actions.length && profile.wallets.some(wallet => wallet.notify)) ||
      (own() && (equity || loss || gap));
    if (!applies) return;
    lastAlertCheck = Date.now();
    try {
      await request("/api/run-alerts", "POST");
      if (active === "alerts") inbox();
    } catch {
      // The next check retries through the same endpoint.
    }
  }
  if (siteRuntime) setInterval(checkWhileOpen, 25000);
  setInterval(() => {
    if (document.hidden) return;
    if (active === "wallets") loadCards();
    if (active === "activity" || active === "compare") render();
    if (active === "alerts") inbox();
  }, 45000);
  return { onSnapshot: () => { if (active === "risk") riskPage(); } };
}
