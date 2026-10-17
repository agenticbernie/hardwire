import assert from "node:assert/strict";
import test from "node:test";
import { createServiceBindingFetcher } from "../src/worker.ts";
import { WorkerClient } from "../src/worker-client.ts";

test("Cloudflare Data Worker service binding receives authenticated API requests", async () => {
  let received: Request | undefined;
  const bindingFetcher = createServiceBindingFetcher({
    async fetch(request) {
      received = request;
      return Response.json({ project: { id: "project-1" } }, { status: 201 });
    },
  });
  const client = new WorkerClient("https://hardwire-data.bernie-web3.workers.dev", "service-token-for-test", "founder", bindingFetcher);

  const result = await client.json("/v1/projects", "POST", { name: "Gunny Arcade" });

  assert.deepEqual(result, { project: { id: "project-1" } });
  assert.equal(received?.url, "https://hardwire-data.bernie-web3.workers.dev/v1/projects");
  assert.equal(received?.method, "POST");
  assert.equal(received?.headers.get("authorization"), "Bearer service-token-for-test");
  assert.equal(received?.headers.get("x-founder-id"), "founder");
  assert.deepEqual(await received?.json(), { name: "Gunny Arcade" });
});
