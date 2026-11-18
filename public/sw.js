self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  let item;
  try { item = event.data?.json(); } catch {}
  event.waitUntil(self.registration.showNotification(item?.title || "Hyper 盯盘", {
    body: item?.body || "你有一条新的盯盘提醒。",
    tag: item?.tag || "hyper-watch",
    icon: "/icon.png",
    data: { path: "/#alerts" },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL(event.notification.data?.path === "/#alerts" ? "/#alerts" : "/", self.location.origin);
    const active = windows.find(window => new URL(window.url).origin === self.location.origin);
    if (active) {
      await active.focus();
      await active.navigate(target.href);
    } else {
      await self.clients.openWindow(target.href);
    }
  })());
});
