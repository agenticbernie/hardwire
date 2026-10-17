import { serve } from "@hono/node-server";
import { createApp, type WorkerBindings } from "./app.ts";
import { readConfig } from "./config.ts";

try {
  const config = readConfig();
  const app = createApp(config);
  const server = serve({
    fetch: (request) => app.fetch(request, {} as WorkerBindings),
    hostname: config.host,
    port: config.port,
  });
  if ("requestTimeout" in server) server.requestTimeout = 60_000;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
} catch {
  // Configuration errors may originate in third-party code. Do not log env values.
  process.stderr.write("Hardwire API could not start. Check required configuration.\n");
  process.exitCode = 1;
}
