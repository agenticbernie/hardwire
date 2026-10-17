import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";

try {
  const config = readConfig();
  const app = await createApp(config);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
  await app.listen({ host: config.host, port: config.port });
} catch {
  // Configuration errors may originate in third-party code. Do not log env values.
  process.stderr.write("Hardwire API could not start. Check required configuration.\n");
  process.exitCode = 1;
}
