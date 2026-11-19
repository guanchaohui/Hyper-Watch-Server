const edgeGuard = 24;
const intentDistance = 12;
const pageDistance = 56;
const axisRatio = 1.4;

export function enablePageSwipe(surface, { canStart, currentView, preview, move }) {
  let start;

  function delta(touch, origin) {
    return { x: touch.clientX - origin.x, y: touch.clientY - origin.y };
  }

  function reset(restore = true) {
    if (!start) return;
    const { horizontal, listeners } = start;
    start = null;
    listeners.abort();
    if (horizontal && restore) preview(null);
  }

  surface.addEventListener("touchstart", event => {
    reset();
    if (event.touches.length !== 1 || !canStart(event.target)) return;
    const touch = event.touches[0];
    if (touch.clientX < edgeGuard || touch.clientX > document.documentElement.clientWidth - edgeGuard) return;
    const listeners = new AbortController();
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, view: currentView(), horizontal: false, listeners };
    const options = { passive: true, signal: listeners.signal };
    // Live data can replace the touched card before the gesture ends.
    event.target.addEventListener("touchend", finish, options);
    event.target.addEventListener("touchcancel", () => reset(), options);
  }, { passive: true });

  surface.addEventListener("touchmove", event => {
    if (!start) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== start.id || currentView() !== start.view) {
      reset();
      return;
    }
    const { x, y } = delta(touch, start);
    if (!start.horizontal) {
      if (Math.max(Math.abs(x), Math.abs(y)) < intentDistance) return;
      if (Math.abs(x) <= axisRatio * Math.abs(y) || !event.cancelable) {
        reset();
        return;
      }
      start.horizontal = true;
    }
    // A deliberate horizontal gesture must not tap the starting tab on release.
    if (event.cancelable) event.preventDefault();
    preview(x);
  }, { passive: false });

  function finish(event) {
    if (start?.horizontal && !event.touches.length && currentView() === start.view &&
        window.getSelection()?.isCollapsed !== false) {
      const touch = [...event.changedTouches].find(item => item.identifier === start.id);
      if (touch) {
        const { x, y } = delta(touch, start);
        if (Math.abs(x) >= pageDistance && Math.abs(x) > axisRatio * Math.abs(y) && move(x < 0 ? 1 : -1)) {
          reset(false);
          return;
        }
      }
    }
    reset();
  }
}
