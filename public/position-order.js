export const positionKey = row => JSON.stringify([row.dex, row.coin]);

export function orderPositions(rows, order) {
  if (!Array.isArray(order)) return rows;
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...rows].sort((left, right) => (rank.get(positionKey(left)) ?? order.length) - (rank.get(positionKey(right)) ?? order.length));
}

export function moveKey(keys, source, target, after) {
  const from = keys.indexOf(source);
  if (source === target || from < 0 || !keys.includes(target)) return null;
  const next = [...keys];
  next.splice(from, 1);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

export function movedPositionOrder(rows, saved, source, target, after) {
  const keys = moveKey(rows.map(positionKey), source, target, after);
  if (!keys) return null;
  const active = new Set(keys);
  const absent = Array.isArray(saved) ? saved.filter(key => typeof key === "string" && !active.has(key)) : [];
  return [...new Set([...keys, ...absent])];
}

export function setupCardOrdering(body, move, refresh, {
  grip = "[data-position-grip]",
  cardSelector = ".position-card",
  keyOf = card => card.dataset.position,
  horizontal = card => getComputedStyle(card.parentElement).gridTemplateColumns.split(" ").length > 1,
} = {}) {
  let drag;

  function updateTarget(x, y) {
    const target = document.elementFromPoint(x, y)?.closest(cardSelector);
    if (drag.target) delete drag.target.dataset.drop;
    drag.target = target && target !== drag.card && body.contains(target) ? target : null;
    if (!drag.target) return;
    const rect = target.getBoundingClientRect();
    drag.after = horizontal(target) ? x >= rect.left + rect.width / 2 : y >= rect.top + rect.height / 2;
    target.dataset.drop = drag.after ? "after" : "before";
  }

  function scrollAtEdge() {
    if (!drag) return;
    drag.frame = undefined;
    const dock = document.querySelector(".mobile-dock");
    const bottom = window.innerHeight - (dock?.offsetHeight ?? 0);
    const y = drag.y;
    const delta = y < 60 ? -12 : y > bottom - 60 ? 12 : 0;
    if (!delta) return;
    const scrolling = document.scrollingElement;
    const before = scrolling.scrollTop;
    scrolling.scrollTop += delta;
    if (scrolling.scrollTop === before) return;
    updateTarget(drag.x, drag.y);
    drag.frame = requestAnimationFrame(scrollAtEdge);
  }

  function finish(id, commit) {
    if (drag?.id !== id) return;
    const { card, target, after, handle, frame } = drag;
    drag = undefined;
    if (frame) cancelAnimationFrame(frame);
    delete card.dataset.dragging;
    if (target) delete target.dataset.drop;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    if (commit && target) move(keyOf(card), keyOf(target), after);
    else refresh();
  }

  body.addEventListener("pointerdown", event => {
    const handle = event.target.closest(grip);
    if (!handle || drag || !event.isPrimary || event.button !== 0) return;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, handle, card: handle.closest(cardSelector),
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
  });
  body.addEventListener("pointermove", event => {
    if (drag?.id !== event.pointerId) return;
    if (!drag.card.dataset.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.card.dataset.dragging = "true";
    drag.x = event.clientX;
    drag.y = event.clientY;
    updateTarget(drag.x, drag.y);
    if (!drag.frame) drag.frame = requestAnimationFrame(scrollAtEdge);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    body.addEventListener(type, event => finish(event.pointerId, type === "pointerup"));
  }
  body.addEventListener("keydown", event => {
    const handle = event.target.closest(grip);
    if (!handle || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const card = handle.closest(cardSelector);
    const after = event.key === "ArrowDown" || event.key === "ArrowRight";
    const direction = after ? "nextElementSibling" : "previousElementSibling";
    let sibling = card[direction];
    while (sibling && !sibling.getClientRects().length) sibling = sibling[direction];
    if (sibling) move(keyOf(card), keyOf(sibling), after);
  });

  return {
    active: () => Boolean(drag),
    cancel: () => { if (drag) finish(drag.id, false); },
  };
}
