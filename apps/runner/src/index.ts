import { executeRun } from "./runner.ts";
import { stagePrerequisites } from "./preflight.ts";

if (process.argv.includes("--check-prerequisites")) {
  const result = stagePrerequisites(process.env);
  console.log(JSON.stringify(result));
  process.exitCode = result.ready ? 0 : 2;
} else {
  try {
    const result = await executeRun(process.env);
    process.exitCode = result.blocker ? (result.blocker === "cancelled" ? 130 : 2) : result.outcome === "passed" ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ acceptanceOutcome: "inconclusive", blocker: "service_unavailable", summary: "Runner configuration or initialization failed" }));
    process.exitCode = 2;
  }
}
