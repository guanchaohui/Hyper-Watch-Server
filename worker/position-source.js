import { allPerpPositions } from "./hyperliquid.js";

const positions = new Map();
const lifetime = 40_000;

export function rememberPositions(wallet, rows, at = Date.now()) {
  positions.delete(wallet);
  if (positions.size >= 32) positions.delete(positions.keys().next().value);
  positions.set(wallet, { rows, at });
}

export function forgetPositions(wallet) {
  positions.delete(wallet);
}

export async function fullPositionSnapshot(wallet, priority = false) {
  const saved = positions.get(wallet);
  if (saved && Date.now() - saved.at <= lifetime) return saved;
  const started = Date.now();
  const rows = await allPerpPositions(wallet, priority);
  const current = positions.get(wallet);
  if (current?.at >= started) return current;
  const snapshot = { rows, at: Date.now() };
  // REST can support several concurrent views without another round of requests.
  rememberPositions(wallet, snapshot.rows, snapshot.at);
  return snapshot;
}
