import { spawn } from "node:child_process";

export interface ProcessResult { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string; elapsedMs: number; outputLimited: boolean; }
export interface ProcessOptions { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; input?: string; onLine?: (line: string) => void; maxOutputBytes?: number; }

export async function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error("Process cancelled before start");
  return new Promise((resolve, reject) => {
    const started = Date.now(), limit = options.maxOutputBytes ?? 8 * 1024 * 1024;
    let stdout = "", stderr = "", lineBuffer = "", bytes = 0, timedOut = false, outputLimited = false, forceTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const terminate = (): void => {
      try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* Process may already have exited. */ }
      forceTimer ??= setTimeout(() => { try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* Exited. */ } }, 2000);
      forceTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, options.timeoutMs));
    const abort = (): void => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const consume = (data: Buffer, stream: "stdout" | "stderr"): void => {
      bytes += data.length;
      if (bytes > limit) { outputLimited = true; terminate(); return; }
      const text = data.toString("utf8");
      if (stream === "stdout") {
        stdout += text; lineBuffer += text;
        const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() ?? "";
        for (const line of lines) { try { options.onLine?.(line); } catch { terminate(); } }
      } else stderr += text;
    };
    child.stdout.on("data", (data: Buffer) => consume(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => consume(data, "stderr"));
    child.stdin.on("error", () => { /* Early command exit closes stdin. */ });
    child.stdin.end(options.input);
    const cleanup = (): void => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); options.signal?.removeEventListener("abort", abort); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (exitCode, signal) => { cleanup(); if (lineBuffer) options.onLine?.(lineBuffer); resolve({ exitCode, signal, timedOut, stdout, stderr, elapsedMs: Date.now() - started, outputLimited }); });
  });
}
