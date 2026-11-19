async function pushTarget(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "push-health:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function readAlertHealth(db, user, target = "cloud-scan-health") {
  const row = await db.prepare("SELECT cursor, breached FROM alert_status WHERE user_id = ? AND target = ?")
    .bind(user, target).first();
  return row ? { ...JSON.parse(row.breached), time: row.cursor } : null;
}

export async function saveAlertHealth(db, user, target, details) {
  try {
    await db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor, breached = excluded.breached")
      .bind(user, target, Date.now(), JSON.stringify(details)).run();
  } catch {
    console.warn("提醒状态记录暂时不可用。");
  }
}

export async function readPushHealth(db, user, endpoint) {
  return readAlertHealth(db, user, await pushTarget(endpoint));
}

export async function savePushHealth(db, user, endpoint, state, test = false) {
  return saveAlertHealth(db, user, await pushTarget(endpoint), { state, test });
}
