const loadedVersion = document.documentElement.dataset.version;
const notice = document.getElementById("version-notice");

if (loadedVersion && notice) {
  let checking = false;
  async function checkVersion() {
    if (document.hidden || checking) return;
    checking = true;
    try {
      const response = await fetch("/version.json", { cache: "no-store" });
      if (!response.ok) return;
      const { version } = await response.json();
      if (typeof version === "string" && /^[a-f0-9]{64}$/.test(version)) {
        notice.hidden = version === loadedVersion;
      }
    } catch {
      // Try again on the next check when the server is reachable.
    } finally {
      checking = false;
    }
  }

  document.getElementById("version-reload").addEventListener("click", () => location.reload());
  document.addEventListener("visibilitychange", checkVersion);
  window.addEventListener("online", checkVersion);
  window.addEventListener("pageshow", checkVersion);
  setInterval(checkVersion, 60_000);
  checkVersion();
}
