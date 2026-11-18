const encoder = new TextEncoder();
const txt = value => encoder.encode(value);

export function base64url(data) {
  return btoa(String.fromCharCode(...new Uint8Array(data))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function decode64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
}

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

export function cleanSubscription(input) {
  try {
    const endpoint = new URL(input.endpoint);
    const host = endpoint.hostname;
    const provider = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
      host === "web.push.apple.com" || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || !provider ||
      endpoint.href.length > 3500 || decode64(input.keys.p256dh).length !== 65 || decode64(input.keys.auth).length !== 16) return null;
    return { endpoint: endpoint.href, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth }, since: Date.now() };
  } catch {
    return null;
  }
}

async function mac(key, data) {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

export async function sealPush(subscription, message) {
  const clientPub = decode64(subscription.keys.p256dh);
  const clientKey = await crypto.subtle.importKey("raw", clientPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPub = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, ephemeral.privateKey, 256));

  // RFC 8291 uses the client and sender public keys in the HKDF context.
  const one = Uint8Array.of(1);
  const authKey = await mac(decode64(subscription.keys.auth), secret);
  const context = concat(txt("WebPush: info\0"), clientPub, serverPub, one);
  const ikm = await mac(authKey, context);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await mac(salt, ikm);
  const contentKey = (await mac(prk, concat(txt("Content-Encoding: aes128gcm\0"), one))).subarray(0, 16);
  const nonce = (await mac(prk, concat(txt("Content-Encoding: nonce\0"), one))).subarray(0, 12);
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const clear = concat(txt(JSON.stringify(message)), Uint8Array.of(2));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, clear));
  const record = new Uint8Array(5);
  new DataView(record.buffer).setUint32(0, 4096);
  record[4] = serverPub.length;
  return concat(salt, record, serverPub, cipher);
}

async function token(env, origin) {
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64url(txt(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(txt(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 21600,
    sub: env.PUBLIC_ORIGIN,
  })));
  const input = header + "." + claims;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, txt(input));
  return input + "." + base64url(signature);
}

export async function sendPush(env, subscription, message) {
  if (!cleanSubscription(subscription)) return "expired";
  const origin = new URL(subscription.endpoint).origin;
  const [jwt, body, key] = await Promise.all([
    token(env, origin), sealPush(subscription, message), crypto.subtle.digest("SHA-256", txt(message.tag)),
  ]);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "3600",
      Urgency: "normal",
      Topic: base64url(key).slice(0, 32),
    },
    body,
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (response.status === 404 || response.status === 410) return "expired";
  if (!response.ok) throw new Error("Push HTTP " + response.status);
  return "sent";
}
