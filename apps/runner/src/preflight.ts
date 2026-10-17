export function stagePrerequisites(environment: NodeJS.ProcessEnv) {
  const missing = ["OPENAI_API_KEY", "WOKWI_CLI_TOKEN"].filter((name) => !environment[name]);
  return { ready: missing.length === 0, blocker: missing.length ? "missing_secret" as const : undefined, missing, simulationStatus: environment.WOKWI_CLI_TOKEN ? "credential_present_not_yet_verified" : "blocked_missing_secret", exactDollarEnforcement: false as const };
}
