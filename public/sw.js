function notificationPath(value) {
  if (typeof value !== "string" || !value.startsWith("/?wallet=")) return "/#alerts";
  const query = new URLSearchParams(value.slice(2));
  const wallet = query.get("wallet"), coin = query.get("position");
  if (!/^0x[0-9a-f]{40}$/.test(wallet ?? "") || (coin !== null && !/^[a-z0-9:@._\/-]{1,64}$/i.test(coin))) return "/#alerts";
  const safe = new URLSearchParams({ wallet });
  if (coin) safe.set("position", coin);
  return "/?" + safe;
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  let item;
  try { item = event.data?.json(); } catch {}
  event.waitUntil((async () => {
    let confirmedAccount = false;
    if (item?.account) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch("/api/account", {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        confirmedAccount = response.ok && (await response.json()).username === item.account;
      } catch {
        // Still show a notification if the browser wakes while the server is unreachable.
      } finally {
        clearTimeout(timeout);
      }
    }
    await self.registration.showNotification((confirmedAccount && item.title) || "盯盘提醒", {
      body: confirmedAccount ? (item.body ?? "") : "你有一条新的盯盘提醒，打开看板查看。",
      tag: (confirmedAccount && item.tag) || "hyper-watch",
      icon: "/icon.png",
      ...(confirmedAccount && Number.isFinite(item.timestamp) ? { timestamp: item.timestamp } : {}),
      data: { path: confirmedAccount ? notificationPath(item.path) : "/#alerts" },
    });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL(notificationPath(event.notification.data?.path), self.location.origin);
    const active = windows.find(window => new URL(window.url).origin === self.location.origin);
    if (active) {
      await active.focus();
      await active.navigate(target.href);
    } else {
      await self.clients.openWindow(target.href);
    }
  })());
});
