import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

const hostname = String(process.argv[2] || "").toLowerCase();
const labels = hostname.split(".");
if (hostname.length > 253 || labels.length < 2 || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/i.test(labels.at(-1)) ||
  !labels.every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
  console.error("请输入完整域名，例如 hyper.example.com，使用 Punycode 格式的国际域名也可。");
  process.exit(1);
}
const password = readFileSync(0, "utf8");
if (password.length < 16 || password.length > 256 || password.includes("\0")) {
  console.error("登录密码须为 16 至 256 个字符。");
  process.exit(1);
}
const salt = randomBytes(24).toString("base64url");
const hash = scryptSync(password, salt, 48).toString("base64url");
const sessionKey = randomBytes(48).toString("base64url");
console.log(`PUBLIC_ORIGIN=https://${hostname}
HYPER_PASSWORD_HASH=${salt}.${hash}
HYPER_SESSION_KEY=${sessionKey}
HYPER_HOST_PORT=8788
HYPER_ALERT_MINUTES=5`);
