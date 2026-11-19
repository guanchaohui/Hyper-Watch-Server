const edgeGuard = 24;
const intentDistance = 12;
const pageDistance = 56;
const axisRatio = 1.4;

export function enablePageSwipe(surface, { canStart, currentView, move }) {
  let start;

  function delta(touch, origin) {
    return { x: touch.clientX - origin.x, y: touch.clientY - origin.y };
  }

  surface.addEventListener("touchstart", event => {
    start = null;
    if (event.touches.length !== 1 || !canStart(event.target)) return;
    const touch = event.touches[0];
    if (touch.clientX < edgeGuard || touch.clientX > document.documentElement.clientWidth - edgeGuard) return;
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, view: currentView(), horizontal: false };
  }, { passive: true });

  surface.addEventListener("touchmove", event => {
    if (!start) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== start.id) {
      start = null;
      return;
    }
    if (!start.horizontal) {
      const { x, y } = delta(touch, start);
      if (Math.max(Math.abs(x), Math.abs(y)) < intentDistance) return;
      if (Math.abs(x) <= axisRatio * Math.abs(y) || !event.cancelable) {
        start = null;
        return;
      }
      start.horizontal = true;
    }
    // A deliberate horizontal gesture must not tap the starting tab on release.
    if (event.cancelable) event.preventDefault();
  }, { passive: false });

  surface.addEventListener("touchend", event => {
    const gesture = start;
    start = null;
    if (!gesture?.horizontal || event.touches.length || currentView() !== gesture.view) return;
    const touch = [...event.changedTouches].find(item => item.identifier === gesture.id);
    if (!touch || window.getSelection()?.isCollapsed === false) return;
    const { x, y } = delta(touch, gesture);
    if (Math.abs(x) < pageDistance || Math.abs(x) <= axisRatio * Math.abs(y)) return;
    move(x < 0 ? 1 : -1);
  }, { passive: true });

  surface.addEventListener("touchcancel", () => { start = null; }, { passive: true });
}
