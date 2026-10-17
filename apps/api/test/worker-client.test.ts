import test from "node:test";
import assert from "node:assert/strict";
import { WorkerClient } from "../src/worker-client.ts";

test("data Worker requests use manual redirects and reject 3xx without following", async () => {
  let fetches = 0;
  const client = new WorkerClient("https://data.example", "x".repeat(32), "founder", async (_input, init) => {
    fetches++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://untrusted.example/" } });
  });
  await assert.rejects(client.json("/v1/projects"), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "service_unavailable");
  assert.equal(fetches, 1, "the redirect destination must not be fetched");
});
