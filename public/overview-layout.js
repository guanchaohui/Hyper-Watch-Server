import { moveKey, setupCardOrdering } from "./position-order.js";

const summary = ["equity", "today", "pnl", "floating", "realized", "risk"];

export function overviewKeys(compact, quick) {
  if (compact) return [...summary, "positions", "events", "trend", "exposure", "comparison"];
  if (quick) return [...summary, "positions", "trend", "exposure", "comparison", "events"];
  return [...summary, "trend", "exposure", "positions", "comparison", "events"];
}

export function savedOverviewKeys(fallback, saved) {
  if (!Array.isArray(saved)) return fallback;
  return [...new Set([...saved.filter(key => fallback.includes(key)), ...fallback])];
}

export function setupOverviewLayout(load, store, compact, makeGrip) {
  const dashboard = document.getElementById("dashboard");
  const grid = document.getElementById("overview-layout");
  const open = document.getElementById("overview-edit");
  const actions = document.getElementById("overview-layout-actions");
  const reset = document.getElementById("overview-reset");
  const status = document.getElementById("overview-order-status");
  const cards = new Map();
  let saved = load("overview-layout", null);
  let editing = false;

  for (const panel of [...grid.children]) {
    const { overviewCard: key, overviewLabel: label } = panel.dataset;
    const card = document.createElement("div");
    card.className = "overview-widget";
    card.dataset.overviewKey = key;
    if (panel.classList.contains("metric")) card.dataset.kind = "metric";
    const handle = makeGrip(label + " 模块");
    handle.removeAttribute("data-position-grip");
    handle.dataset.overviewGrip = "";
    handle.hidden = true;
    panel.before(card);
    card.append(handle, panel);
    cards.set(key, { card, handle, label });
  }

  const order = () => savedOverviewKeys(overviewKeys(compact.matches, document.body.classList.contains("quick-mode")), saved);
  function arrange() {
    const next = order();
    const current = [...grid.children].map(card => card.dataset.overviewKey);
    if (next.some((key, index) => key !== current[index])) {
      for (const key of next) grid.append(cards.get(key).card);
    }
  }

  function move(source, target, after) {
    const next = moveKey(order(), source, target, after);
    if (!next) return;
    saved = next;
    store("overview-layout", saved);
    arrange();
    const { handle, label, card } = cards.get(source);
    handle.focus({ preventScroll: true });
    handle.scrollIntoView({ block: "nearest" });
    const visible = [...grid.children].filter(node => node.getClientRects().length);
    status.textContent = label + " 已移到第 " + (visible.indexOf(card) + 1) + " 位";
  }

  const drag = setupCardOrdering(grid, move, arrange, {
    grip: "[data-overview-grip]", cardSelector: ".overview-widget", keyOf: card => card.dataset.overviewKey,
    horizontal: card => [...grid.children].some(other => other !== card && other.getClientRects().length && other.offsetTop === card.offsetTop),
  });

  function sync() {
    const available = !grid.hidden && !dashboard.hidden && dashboard.dataset.section === "over";
    if (!available && editing) {
      drag.cancel();
      editing = false;
    }
    open.hidden = !available;
    open.textContent = editing ? "完成" : "编辑布局";
    open.setAttribute("aria-pressed", String(editing));
    actions.hidden = !editing;
    grid.toggleAttribute("data-editing", editing);
    for (const { handle } of cards.values()) handle.hidden = !editing;
    if (!drag.active()) arrange();
  }

  open.addEventListener("click", () => { drag.cancel(); editing = !editing; sync(); });
  reset.addEventListener("click", () => {
    drag.cancel();
    saved = null;
    store("overview-layout", null);
    status.textContent = "已恢复默认布局";
    sync();
  });
  compact.addEventListener("change", () => { drag.cancel(); sync(); });
  return { sync };
}
