import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { flushFillAlerts, recordFillAlerts } from "../dist/server/trade-alerts.js";

test("成交合并按账户、钱包、品种和动作隔离，阈值按合计，回放不重复", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const file of ["0000_watchlist.sql", "0002_trade_alert_buffer.sql"]) {
    sqlite.exec(await readFile(new URL("../drizzle/" + file, import.meta.url), "utf8"));
  }
  sqlite.exec("ALTER TABLE alerts ADD COLUMN title TEXT");
  const db = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return { bind: (...params) => ({
        all: () => ({ results: stmt.all(...params) }),
        run: () => ({ meta: stmt.run(...params) }),
      }) };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(stmt => stmt.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const wallet = { address: "0x" + "a".repeat(40), name: "关注钱包", minTradeValue: 200 };
  const other = { address: "0x" + "b".repeat(40), minTradeValue: 200, tradeCooldown: 20 };
  const selected = ["add", "reduce", "open", "close", "reverse"];
  const base = 1_800_000_000_000;
  let now = base;
  t.mock.method(Date, "now", () => now);
  const fill = (id, start, px, time = now, extra = {}) => ({
    tid: id, oid: id, coin: "ETH", dir: "Open Long", side: "B", time, startPosition: String(start), sz: "1", px: String(px), ...extra,
  });
  const rules = { actions: selected, notificationFields: ["trade", "position", "notional", "pnl"] };
  const record = (user, target, ...rows) => recordFillAlerts(db, user, target, rules, rows);
  const read = user => sqlite.prepare("SELECT event_id, title, body FROM alerts WHERE user_id = ? ORDER BY created_at, event_id").all(user);
  const first = fill(1, 1, 100);
  await record("alice", wallet, first);
  await record("bob", wallet, first);
  await record("alice", other, first);
  now += 4000;
  const second = fill(2, 2, 110);
  await record("alice", wallet, second);
  assert.equal(await record("alice", wallet, first, second), false);
  assert.equal((await flushFillAlerts(db)).size, 0);
  now = base + 10000;
  assert.deepEqual([...await flushFillAlerts(db)], ["alice"]);
  assert.equal(read("bob").length, 0);
  assert.equal(read("alice").length, 1);
  assert.equal(read("alice")[0].title, "🟢 ETH · 加多 · 2 笔");
  assert.match(read("alice")[0].body, /成交：2 张 @ \$105\n仓位价值：\$105\.00 → \$315\.00\n名义价值：\$210\.00/);
  assert.equal(await record("alice", { ...wallet, tradeCooldown: 0, minTradeValue: 0 }, first, second), false);
  assert.equal((await flushFillAlerts(db)).size, 0);

  now += 2000;
  const reduce = fill(3, 3, 100, now, { dir: "Close Long", side: "A", closedPnl: "3.5" });
  const reduce2 = fill(4, 2, 110, now + 500, { dir: "Close Long", side: "A", closedPnl: "2.5" });
  await record("alice", wallet, reduce, reduce2);
  now += 1000;
  await record("alice", wallet, fill(5, 1, 50, now, { dir: "Close Long", side: "A" }));
  assert.ok(read("alice").some(item => item.title === "🟢 ETH · 平多"));
  assert.deepEqual([...await flushFillAlerts(db)], ["alice"]);
  const notices = read("alice");
  assert.deepEqual(notices.map(item => item.title), ["🟢 ETH · 加多 · 2 笔", "🟢 ETH · 减多 · 2 笔", "🟢 ETH · 平多"]);
  assert.match(notices[1].body, /已实现盈亏：\+6.00/);
  now += 10_000;
  assert.equal((await flushFillAlerts(db)).size, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM trade_alert_buffer WHERE finalized = 0").get().n, 0);
});
