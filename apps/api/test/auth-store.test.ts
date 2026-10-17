import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { D1FounderAuthStore } from "../src/auth-store.ts";
import type { D1Database } from "../src/auth-store.ts";

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) { values = input; return statement; },
        async first<T>() { return (database.prepare(sql).get(...values as SQLInputValue[]) ?? null) as T | null; },
        async run() { return database.prepare(sql).run(...values as SQLInputValue[]); },
      };
      return statement;
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("D1 founder sessions survive store recreation and rate limits persist with hashed keys", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../../../db/migrations/0001_hardwire.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../../../db/migrations/0002_founder_auth.sql", import.meta.url), "utf8"));
  const binding = d1(database);
  const store = new D1FounderAuthStore(binding);

  await store.rotateSession("a".repeat(64), { csrfToken: "b".repeat(64), expiresAt: 500_000 }, 1_000);
  const restartedStore = new D1FounderAuthStore(binding);
  assert.deepEqual(await restartedStore.session("a".repeat(64), 2_000), { csrfToken: "b".repeat(64), expiresAt: 500_000 });
  await restartedStore.rotateSession("c".repeat(64), { csrfToken: "d".repeat(64), expiresAt: 500_000 }, 2_000);
  assert.equal(await store.session("a".repeat(64), 2_000), undefined);
  assert.equal((await store.session("c".repeat(64), 2_000))?.csrfToken, "d".repeat(64));

  await store.takeRateLimit("login:192.0.2.7", 2, 60_000, 1_000);
  await restartedStore.takeRateLimit("login:192.0.2.7", 2, 60_000, 2_000);
  await assert.rejects(restartedStore.takeRateLimit("login:192.0.2.7", 2, 60_000, 3_000), { status: 429 });
  const bucket = database.prepare("SELECT bucket_hash FROM founder_rate_limits").get() as { bucket_hash: string };
  assert.notEqual(bucket.bucket_hash, "login:192.0.2.7");
  await restartedStore.takeRateLimit("login:192.0.2.7", 2, 60_000, 62_000);
  database.close();
});
