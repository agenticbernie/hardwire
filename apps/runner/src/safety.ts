import { createHash } from "node:crypto";
import { readdir, lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { inflateSync } from "node:zlib";
import { evidenceIdentityMatches } from "../../../packages/contracts/src/index.ts";
import type { ApprovalMaterial, EvidenceIdentity } from "../../../packages/contracts/src/index.ts";

export const SNAPSHOT = "f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc";
export const SNAPSHOT_TREE = "11775b2baab2a56d009f9d2d89007961d6d4d2ac";
export const MAX_STEPS = 24;
export const MAX_AGENT_CALLS = 8; // implement + evaluate + three (repair + evaluate)
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export type Role = "agent" | "build" | "simulation" | "fetch";
export type FileMap = Record<string, string>;
export type Outcome = "passed" | "failed" | "inconclusive";
export type Blocker = "missing_secret" | "service_unavailable" | "quota_exhausted" | "timeout" | "invalid_evidence" | "budget_measured" | "step_limit" | "call_limit" | "cancelled" | "runner_lost" | "disallowed_diff";
export interface Usage { inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; }
export interface Evidence extends EvidenceIdentity { artifactId: string; kind: "build_log" | "serial_log" | "screenshot" | "diff" | "report" | "checkpoint"; valid: boolean; sha256: string; byteSize: number; mediaType: string; capturedAt: string; toolVersions: Record<string, string>; }
export interface Proposal { criterionId: string; outcome: Outcome; explanation: string; evidenceIds: string[]; }
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function safeEnvironment(role: Role, source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { PATH: "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/home", XDG_CONFIG_HOME: "/tmp/config", XDG_DATA_HOME: "/tmp/data", XDG_CACHE_HOME: "/tmp/cache", LANG: "C.UTF-8", CI: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  if (role === "agent" && source.OPENAI_API_KEY) env.OPENAI_API_KEY = source.OPENAI_API_KEY;
  if (role === "simulation" && source.WOKWI_CLI_TOKEN) env.WOKWI_CLI_TOKEN = source.WOKWI_CLI_TOKEN;
  if (role === "build") env.PLATFORMIO_CORE_DIR = "/tool-cache/platformio";
  return env;
}

export function redact(text: string, secrets: string[] = []): string {
  let value = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join("[REDACTED]");
  return value.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|wok_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,"']+/gi, "$1[REDACTED]");
}

export function safePath(path: string): boolean {
  return path.length > 0 && path.length < 300 && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/")
    && path === posix.normalize(path) && !path.split("/").some((part) => !part || part === ".." || part === ".");
}

export async function fileMap(root: string): Promise<FileMap> {
  const files: FileMap = {};
  let total = 0;
  async function walk(relative: string): Promise<void> {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (!safePath(path)) throw new Error(`Unsafe source path: ${path}`);
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) throw new Error(`Source symlink rejected: ${path}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES || (total += stat.size) > MAX_SOURCE_BYTES || Object.keys(files).length >= 1000) throw new Error("Source size limit exceeded");
        files[path] = (await readFile(join(root, path))).toString("base64");
      } else throw new Error(`Special source file rejected: ${path}`);
    }
  }
  await walk("");
  return files;
}

export function sourceHash(files: FileMap): string {
  return sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, sha256(Buffer.from(content, "base64"))])));
}

function matches(path: string, pattern: string): boolean {
  if (!safePath(pattern.replace(/\*\*?/g, "wildcard"))) return false;
  const expression = pattern.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${expression}$`).test(path) || (!pattern.includes("*") && path.startsWith(`${pattern.replace(/\/$/, "")}/`));
}

export function assertAllowedChanges(baseline: FileMap, current: FileMap, allowedPaths: string[]): string[] {
  const changed = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].filter((path) => baseline[path] !== current[path]).sort();
  for (const path of changed) {
    // This fixed PoC supports C++/header changes only; task approval can narrow this boundary.
    if (!safePath(path) || !/^(src|include)\/[A-Za-z0-9_./-]+\.(cpp|cc|c|h|hpp)$/.test(path)
      || path.split("/").some((part) => part.startsWith(".")) || !allowedPaths.some((pattern) => matches(path, pattern))) {
      throw new Error(`Disallowed product diff: ${path}`);
    }
    if (current[path] && Buffer.from(current[path], "base64").includes(0)) throw new Error(`Binary source rejected: ${path}`);
  }
  return changed;
}

export function diffText(baseline: FileMap, current: FileMap, changed: string[]): string {
  return changed.map((path) => {
    const before = baseline[path] ? Buffer.from(baseline[path], "base64").toString("utf8").split("\n") : [];
    const after = current[path] ? Buffer.from(current[path], "base64").toString("utf8").split("\n") : [];
    let start = 0, endBefore = before.length, endAfter = after.length;
    while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
    return [`--- ${baseline[path] ? `a/${path}` : "/dev/null"}`, `+++ ${current[path] ? `b/${path}` : "/dev/null"}`, `@@ -${start + 1},${endBefore - start} +${start + 1},${endAfter - start} @@`, ...before.slice(start, endBefore).map((line) => `-${line}`), ...after.slice(start, endAfter).map((line) => `+${line}`)].join("\n");
  }).join("\n");
}

export function parseUsage(event: unknown): (Usage & { stepId: string }) | undefined {
  const row = event as { type?: string; part?: { id?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } } };
  if (row?.type !== "step_finish" || !row.part?.tokens || !row.part.id || typeof row.part.cost !== "number" || !Number.isFinite(row.part.cost) || row.part.cost < 0) return undefined;
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const t = row.part.tokens;
  return { stepId: row.part.id, inputTokens: number(t.input), outputTokens: number(t.output), reasoningTokens: number(t.reasoning), cacheReadTokens: number(t.cache?.read), cacheWriteTokens: number(t.cache?.write), costUsd: number(row.part.cost) };
}

export function budgetStop(usage: { steps: number; costUsd: number; elapsedMs: number; repairs: number; calls?: number }, limits: ApprovalMaterial["limits"]): Blocker | undefined {
  if (usage.elapsedMs >= Math.min(1800, limits.timeoutSeconds) * 1000) return "timeout";
  if (usage.costUsd >= limits.maxUsd) return "budget_measured";
  if (usage.steps >= MAX_STEPS) return "step_limit";
  if ((usage.calls ?? 0) >= MAX_AGENT_CALLS) return "call_limit";
  return undefined;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decode the non-interlaced 8-bit PNG formats emitted by the simulator. */
export function decodePng(bytes: Buffer): { width: number; height: number; distinctColors: number } {
  const bad = (): never => { throw new Error("Invalid or unsupported PNG evidence"); };
  if (bytes.length < 45 || bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return bad();
  let width = 0, height = 0, channels = 0, colorType = 0, ended = false;
  let palette: Buffer = Buffer.alloc(0);
  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) return bad();
    const len = bytes.readUInt32BE(offset), end = offset + 12 + len;
    if (end > bytes.length) return bad();
    const type = bytes.toString("ascii", offset + 4, offset + 8), chunk = bytes.subarray(offset + 8, offset + 8 + len);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + len)) !== bytes.readUInt32BE(offset + 8 + len)) return bad();
    if (type === "IHDR") {
      if (offset !== 8 || len !== 13) return bad();
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); colorType = chunk[9]!;
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType] ?? 0;
      if (!width || !height || width * height > 1024 * 1024 || chunk[8] !== 8 || !channels || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) return bad();
    } else if (type === "IDAT") { if (!width) return bad(); data.push(chunk); }
    else if (type === "PLTE") palette = chunk;
    else if (type === "IEND") { if (len || end !== bytes.length) return bad(); ended = true; }
    else if (type[0] === type[0]?.toUpperCase() && !["tRNS"].includes(type)) return bad();
    offset = end;
  }
  if (!ended || !data.length || (colorType === 3 && (!palette.length || palette.length % 3))) return bad();
  const stride = width * channels;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height }); } catch { return bad(); }
  if (raw.length !== (stride + 1) * height) return bad();
  const pixels = Buffer.alloc(stride * height), colors = new Set<string>();
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) return bad();
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y ? pixels[(y - 1) * stride + x]! : 0;
      const corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const prediction = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner) : 0;
      pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1]! + prediction) & 255;
    }
    for (let x = 0; x < stride; x += channels) {
      const pixel = pixels.subarray(y * stride + x, y * stride + x + channels);
      if (colorType === 3 && pixel[0]! * 3 >= palette.length) return bad();
      if (colors.size < 1024) colors.add(pixel.toString("hex"));
    }
  }
  return { width, height, distinctColors: colors.size };
}

export function evaluateCriteria(criteria: ApprovalMaterial["criteria"], proposals: Proposal[], evidence: Evidence[], identity: EvidenceIdentity, blocker: string | undefined) {
  return criteria.map((criterion) => {
    const proposalsFor = proposals.filter((p) => p.criterionId === criterion.id);
    const proposal = proposalsFor.length === 1 ? proposalsFor[0] : undefined;
    const cited = (proposal?.evidenceIds ?? []).map((id) => evidence.find((e) => e.artifactId === id));
    const valid = cited.length > 0 && cited.every((e) => e && e.valid && evidenceIdentityMatches(evidenceIdentity(e), identity));
    const kinds = new Set(cited.filter(Boolean).map((e) => e!.kind));
    const missing = criterion.evidence.filter((kind) => !kinds.has(kind));
    const admissible = !blocker && valid && missing.length === 0;
    const outcome: Outcome = admissible && proposal ? proposal.outcome : "inconclusive";
    return { criterionId: criterion.id, outcome, explanation: admissible && proposal ? proposal.explanation : `Evidence gate: ${blocker ?? (!proposal ? "missing or duplicate evaluator result" : !valid ? "missing, invalid, or stale evidence" : `missing ${missing.join(", ")}`)}`, evidenceIds: cited.filter((e): e is Evidence => !!e && e.valid && evidenceIdentityMatches(evidenceIdentity(e), identity)).map((e) => e.artifactId), sourceHash: identity.sourceHash, firmwareHash: identity.firmwareHash, scenarioHash: identity.scenarioHash, criteriaHash: identity.criteriaHash };
  });
}

function evidenceIdentity(e: Evidence): EvidenceIdentity { return { runId: e.runId, attempt: e.attempt, testCaseId: e.testCaseId, sourceHash: e.sourceHash, firmwareHash: e.firmwareHash, scenarioHash: e.scenarioHash, criteriaHash: e.criteriaHash }; }
