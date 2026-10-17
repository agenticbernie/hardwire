import { randomUUID } from "node:crypto";
import { safeEnvironment } from "./safety.ts";
import type { Role } from "./safety.ts";
import { runProcess } from "./process.ts";
import type { ProcessResult } from "./process.ts";

export interface SandboxOptions {
  role: Role; sourceDir: string; toolCache: string; evidenceDir?: string; readOnly?: boolean;
  signal: AbortSignal; timeoutMs: number; input?: string; onLine?: (line: string) => void;
  config?: string;
}

export function containerEnvironmentArguments(env: Record<string, string>): string[] {
  return Object.keys(env).flatMap((key) => ["--env", key === "PATH" || key === "HOME" ? `${key}=${env[key]}` : key]);
}

export class DockerSandbox {
  readonly image: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly hostHome: string;
  constructor(image: string, environment: NodeJS.ProcessEnv, hostHome: string) {
    this.image = image; this.environment = environment; this.hostHome = hostHome;
    if (!/^[a-zA-Z0-9./:_@-]+$/.test(image)) throw new Error("Invalid runner image name");
  }

  async run(command: string[], options: SandboxOptions): Promise<ProcessResult> {
    const name = `hardwire-${randomUUID()}`;
    const env = safeEnvironment(options.role, this.environment);
    if (options.config) env.OPENCODE_CONFIG_CONTENT = options.config;
    const args = ["run", "--rm", "--init", "--name", name, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--pids-limit=256", "--memory=3g", "--cpus=2", "--user", `${process.getuid?.() ?? 1001}:${process.getgid?.() ?? 1001}`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g", "--workdir", "/workspace", "--mount", `type=bind,src=${options.sourceDir},dst=/workspace${options.readOnly ? ",readonly" : ""}`];
    if (options.role === "build") args.push("--mount", `type=bind,src=${options.toolCache},dst=/tool-cache`);
    if (options.evidenceDir) args.push("--mount", `type=bind,src=${options.evidenceDir},dst=/evidence,readonly`);
    // Docker needs host paths; only the container receives its fixed sandbox paths.
    // Credential values remain inherited by name, never exposed in process arguments.
    args.push(...containerEnvironmentArguments(env));
    args.push(this.image, ...command);
    const hostEnv = { ...env, HOME: this.hostHome, PATH: "/usr/local/bin:/usr/bin:/bin" };
    try { return await runProcess("docker", args, { cwd: this.hostHome, env: hostEnv, timeoutMs: options.timeoutMs, signal: options.signal, input: options.input, onLine: options.onLine }); }
    finally {
      // Killing the Docker client alone need not stop its container.
      await runProcess("docker", ["rm", "--force", name], { cwd: this.hostHome, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: this.hostHome }, timeoutMs: 5000 }).catch(() => {});
    }
  }
}
