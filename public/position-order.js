export const positionKey = row => JSON.stringify([row.dex, row.coin]);

export function orderPositions(rows, order) {
  if (!Array.isArray(order)) return rows;
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...rows].sort((left, right) => (rank.get(positionKey(left)) ?? order.length) - (rank.get(positionKey(right)) ?? order.length));
}

export function movedPositionOrder(rows, saved, source, target, after) {
  if (source === target) return null;
  const keys = rows.map(positionKey);
  const from = keys.indexOf(source);
  if (from < 0 || !keys.includes(target)) return null;
  keys.splice(from, 1);
  keys.splice(keys.indexOf(target) + Number(after), 0, source);
  const active = new Set(keys);
  const absent = Array.isArray(saved) ? saved.filter(key => typeof key === "string" && !active.has(key)) : [];
  return [...new Set([...keys, ...absent])];
}

export function setupCardOrdering(body, move, refresh) {
  let drag;

  function finish(id, commit) {
    if (drag?.id !== id) return;
    const { card, target, after, handle } = drag;
    drag = undefined;
    delete card.dataset.dragging;
    if (target) delete target.dataset.drop;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    if (commit && target) move(card.dataset.position, target.dataset.position, after);
    else refresh();
  }

  body.addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-position-grip]");
    if (!handle || drag || !event.isPrimary || event.button !== 0) return;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, handle, card: handle.closest(".position-card"), x: event.clientX, y: event.clientY };
  });
  body.addEventListener("pointermove", event => {
    if (drag?.id !== event.pointerId) return;
    if (!drag.card.dataset.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    drag.card.dataset.dragging = "true";
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".position-card");
    if (drag.target) delete drag.target.dataset.drop;
    drag.target = target && target !== drag.card && body.contains(target) ? target : null;
    if (!drag.target) return;
    const rect = target.getBoundingClientRect();
    const columns = getComputedStyle(target.parentElement).gridTemplateColumns.split(" ").length;
    drag.after = columns > 1 ? event.clientX >= rect.left + rect.width / 2 : event.clientY >= rect.top + rect.height / 2;
    target.dataset.drop = drag.after ? "after" : "before";
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    body.addEventListener(type, event => finish(event.pointerId, type === "pointerup"));
  }
  body.addEventListener("keydown", event => {
    const handle = event.target.closest("[data-position-grip]");
    if (!handle || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const card = handle.closest(".position-card");
    const after = event.key === "ArrowDown" || event.key === "ArrowRight";
    const sibling = after ? card.nextElementSibling : card.previousElementSibling;
    if (sibling) move(card.dataset.position, sibling.dataset.position, after);
  });

  return {
    active: () => Boolean(drag),
    cancel: () => { if (drag) finish(drag.id, false); },
  };
}
