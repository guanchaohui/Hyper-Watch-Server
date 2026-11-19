export const ledgerSections = {
  summary: "收益总览", positions: "仓位历史", fill: "成交", funding: "资金费", ledger: "资金流水",
  open: "未成交订单", order: "订单状态", equity: "权益快照",
};
export const ledgerRanges = { today: "今日（UTC+8）", week: "本周", month: "本月", "30d": "近 30 天" };

const datasets = { fill: "成交", funding: "资金费", ledger: "资金流水", equity: "权益快照", order: "订单状态" };
const movementNames = { deposit: "充值", withdraw: "提现", accountClassTransfer: "现货／合约划转",
  internalTransfer: "主账户间转账", subAccountTransfer: "子账户转账", spotTransfer: "现货转账", send: "发送资产",
  dexTransfer: "市场间划转", vaultDeposit: "金库存入", vaultWithdraw: "金库取出" };
const orderStatuses = { open: "挂单中", filled: "已成交", canceled: "已撤销", triggered: "已触发", rejected: "已拒绝",
  marginCanceled: "保证金不足撤销", reduceOnlyCanceled: "只减仓限制撤销", siblingFilledCanceled: "关联订单成交后撤销" };
const steps = { open: "开仓", add: "加仓", reduce: "减仓", close: "平仓", reverseClose: "反手平仓", reverseOpen: "反手开仓" };
const feeToken = row => row.feeToken || "币种未提供";
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const time = value => Number.isFinite(value) && value > 0 ? clock.format(value) : "—";

export function renderLedger(view, result, { esc, table, tip, ui }) {
  const { coverage, rows } = result;
  const money = value => value == null ? "—" : ui.amount(Number(value), { signed: true });
  const quantity = value => value == null || !Number.isFinite(Number(value)) ? "—" : ui.quantity(Number(value));
  const qty = (value, token) => value == null ? "—" : quantity(value) + (token ? " " + token : "");
  const tokens = entries => entries ? Object.entries(entries).map(([ticker, value]) => qty(value, ticker)).join(" / ") || "—" : "—";
  const price = value => value == null ? "—" : "$" + quantity(value);
  const hint = content => '<p class="hint">' + esc(content) + '</p>';
  function coverageLine(kind) {
    const status = coverage[kind];
    const label = datasets[kind];
    if (!status) return label + "等待首次同步";
    if (kind === "order") {
      const earliest = status.since ? " · 最早返回 " + time(status.since) : "";
      return label + " · " + (status.status === "unavailable" ? "暂时无法补档" : "历史订单接口仅提供近期状态") + earliest;
    }
    if (!status.since) return label + "尚无已确认区间";
    const range = time(status.since) + " 至 " + time(status.through);
    if (kind === "equity") return label + "样本 " + range;
    return label + (status.full ? "已覆盖所选区间" : "覆盖有限") + " · " + range +
      (status.status === "retention" ? " · 已到交易所历史保留上限" : status.status === "unavailable" ? " · 暂时无法补档" : "");
  }
  const relevant = view === "summary" ? ["fill", "funding", "ledger"] : view === "positions" ? ["fill", "funding"] : view === "open" ? [] : [view];
  const status = relevant.length ? '<ul class="ledger-coverage">' + relevant.map(kind => "<li>" + esc(coverageLine(kind)) + "</li>").join("") + "</ul>" : "";
  const limit = result.truncated ? hint("当前展示达到记录上限，可缩小区间或查看明细。") : "";
  function details(columns, data, empty) {
    return data.length ? table(columns, data.map(row => row.map(esc))) : tip(empty);
  }

  if (view === "summary") {
    const s = result.summary;
    const stats = [
      ["成交笔数", s.tradeCount == null ? "—" : String(s.tradeCount)], ["合约成交名义金额", money(s.notional)], ["合约已实现盈亏", money(s.realized)], ["当前未实现盈亏", money(result.unrealized)],
      ["资金费收入", tokens(s.fundingIncome)], ["资金费支出", tokens(s.fundingPaid)],
      ["交易手续费（剔除 Builder 费）", tokens(s.fees)], ["Builder 费", tokens(s.builderFees)],
      ["充值", tokens(s.cash?.deposit)], ["提现", tokens(s.cash?.withdraw)], ["转账金额", tokens(s.cash?.transfer)],
    ];
    return status + limit + '<div class="readout-grid">' +
      stats.map(([label, value]) => '<div class="readout"><small>' + esc(label) + '</small><strong>' + esc(value) + '</strong></div>').join("") + '</div>' +
      hint("已实现盈亏按成交接口的 closedPnl 汇总。资金费、费用和账户流水分别按原币种汇总。") +
      (result.positionsAt ? hint("浮动盈亏更新时间 " + time(result.positionsAt) + "（UTC+8）") : "") +
      (s.cashMissing ? hint("部分资金流水未提供可核算金额。") : "");
  }
  if (view === "positions") {
    return status + limit + (rows.length ? rows.map(row => '<details class="ledger-position"><summary><strong>' +
      esc(row.coin + " · " + (row.side === "long" ? "多仓" : "空仓")) + '</strong> <span>' +
      esc(row.complete ? "已平仓" : row.end ? "缺少历史成交" : "未确认完整平仓") + '</span></summary><p class="hint">' +
      esc((row.start ? "开仓 " + time(row.start) : "首次记录 " + time(row.firstSeen)) + " · " +
        (row.end ? "平仓 " + time(row.end) : "最后变动 " + time(row.last))) + '</p><dl class="ledger-breakdown">' +
      [["已实现", money(row.realized)], ["仓位净收益", money(row.net)], ["资金费", tokens(row.funding)],
        ["交易手续费", tokens(row.fees)], ["Builder 费", tokens(row.builderFees)]].map(([label, val]) =>
        "<div><dt>" + esc(label) + "</dt><dd>" + esc(val) + "</dd></div>").join("") + "</dl>" +
      details(["时间", "动作", "仓位变化（张）", "成交价"], row.steps.map(step => [time(step.time), steps[step.action],
        quantity(step.before) + " → " + quantity(step.after), price(step.price)]), "暂无变动") +
      (row.stepCount > row.steps.length ? hint("仅展示此仓位最近 " + row.steps.length + " 次变动。") : "") + '</details>').join("") :
      tip("当前区间暂无可归集的仓位。")) +
      hint("仓位净收益使用合约已实现盈亏，加上净资金费，再扣除手续费和 Builder 费。待补齐的内容以 — 表示。");
  }
  if (view === "open") {
    if (!rows) return tip("等待订单快照同步。");
    const updated = "快照 " + time(result.snapshotAt) + "（UTC+8）" + (result.stale || coverage.open?.status === "unavailable" ? " · 可能已过时" : "");
    return hint(updated) + limit + details(["合约", "方向", "限价", "剩余数量", "触发条件"], rows.map(row => [
      row.coin, (row.side === "B" ? "买入" : row.side === "A" ? "卖出" : "—") + (row.reduceOnly ? " · 只减仓" : ""),
      price(row.limitPx), quantity(row.sz), row.isTrigger ? (row.triggerCondition || "") + " " + price(row.triggerPx) : "—",
    ]), "当前无未成交订单。");
  }
  const grids = {
    fill: [["时间", "资产", "动作", "数量", "价格", "已实现盈亏", "手续费（含 Builder）", "其中 Builder 费"],
      row => [row.coin, row.dir || (row.side === "B" ? "买入" : "卖出"), quantity(row.sz), price(row.px), money(row.closedPnl),
        qty(row.fee, feeToken(row)), qty(row.builderFee ?? (row.fee == null ? null : 0), feeToken(row))]],
    funding: [["时间", "合约", "资金费", "资金费率"], row => [row.coin, qty(row.usdc, row.token || (row.coin?.includes(":") ? "结算金额" : "USDC")),
      row.fundingRate != null && Number.isFinite(Number(row.fundingRate)) ? ui.percent(Number(row.fundingRate) * 100, true) : "—"]],
    ledger: [["时间", "类型", "金额", "方向"], row => [movementNames[row.type] || row.type || "其他流水", qty(row.amount, row.token),
      row.toPerp === true ? "转入合约" : row.toPerp === false ? "转入现货" : "—"]],
    order: [["时间", "资产", "订单", "状态", "价格", "剩余数量"], row => [row.order.coin, row.order.oid,
      orderStatuses[row.status] || row.status, price(row.order.limitPx), quantity(row.order.sz)]],
    equity: [["时间", "账户权益", "官方盈亏曲线样本"], row => [money(row.equity), money(row.pnl)]],
  };
  const [columns, values] = grids[view];
  return status + details(columns, rows.map(row => [time(row.time), ...values(row.data)]), "所选区间暂无已同步的记录。");
}
