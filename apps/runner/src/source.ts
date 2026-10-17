import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { crc32, MAX_SOURCE_BYTES, MAX_FILE_BYTES, safePath, sha256, SNAPSHOT } from "./safety.ts";
import type { FileMap } from "./safety.ts";

/** Bounded ZIP extraction: reject ambiguity, links, encryption, traversal and ZIP64. */
export function unzip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Archive compressed size limit");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error("Invalid ZIP archive");
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (count > 2000 || count !== bytes.readUInt16LE(end + 8) || directoryOffset + directorySize !== end) throw new Error("ZIP directory limit or mismatch");
  const entries = new Map<string, Buffer>(), names = new Set<string>();
  let offset = directoryOffset, total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24), nameLen = bytes.readUInt16LE(offset + 28), extraLen = bytes.readUInt16LE(offset + 30), commentLen = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42), name = bytes.toString("utf8", offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;
    const directory = name.endsWith("/"), path = directory ? name.slice(0, -1) : name;
    if (offset > end || !safePath(path) || names.has(path) || (flags & 1) || ![0, 8].includes(method) || ((attributes >>> 16) & 0xf000) === 0xa000 || bytes.readUInt16LE(offset - 46 - nameLen - extraLen - commentLen + 34)) throw new Error("Unsafe ZIP entry");
    names.add(path);
    if (expanded > 8 * 1024 * 1024 || (total += expanded) > 32 * 1024 * 1024 || local + 30 > directoryOffset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP expanded size or header limit");
    const localNameLen = bytes.readUInt16LE(local + 26), localExtraLen = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameLen + localExtraLen;
    if (bytes.toString("utf8", local + 30, local + 30 + localNameLen) !== name || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags || dataStart + compressed > directoryOffset) throw new Error("ZIP local header mismatch");
    const compressedBytes = bytes.subarray(dataStart, dataStart + compressed);
    const content = method === 0 ? Buffer.from(compressedBytes) : inflateRawSync(compressedBytes, { maxOutputLength: Math.max(expanded, 1) });
    if (content.length !== expanded || crc32(content) !== crc) throw new Error("ZIP entry checksum mismatch");
    if (!directory) entries.set(path, content);
  }
  if (offset !== end) throw new Error("ZIP directory mismatch");
  return entries;
}

export function importedSource(bytes: Buffer): FileMap {
  const entries = unzip(bytes), manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("Missing Hardwire archive manifest");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { format?: string; formatVersion?: number; files?: { path: string; byteSize: number; sha256: string }[] };
  if (manifest.format !== "hardwire-archive" || manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("Unsupported Hardwire archive");
  const listed = new Set<string>(), result: FileMap = {};
  let total = 0;
  for (const file of manifest.files) {
    const data = entries.get(file.path);
    if (!safePath(file.path) || listed.has(file.path) || !data || data.length !== file.byteSize || sha256(data) !== file.sha256) throw new Error("Archive manifest checksum mismatch");
    listed.add(file.path);
    if (file.path.startsWith("source/")) {
      const path = file.path.slice(7);
      if (!safePath(path) || data.length > MAX_FILE_BYTES || (total += data.length) > MAX_SOURCE_BYTES) throw new Error("Unsafe imported source");
      result[path] = data.toString("base64");
    }
  }
  if (entries.size !== listed.size + 1 || !Object.keys(result).length) throw new Error("Archive contains unlisted entries or no source");
  return result;
}

export async function writeSource(root: string, files: FileMap): Promise<void> {
  for (const [path, base64] of Object.entries(files)) {
    if (!safePath(path) || Buffer.from(base64, "base64").length > MAX_FILE_BYTES) throw new Error("Unsafe source path or size");
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), Buffer.from(base64, "base64"));
  }
}

export async function fetchPinnedSnapshot(signal: AbortSignal): Promise<FileMap> {
  const response = await fetch(`https://codeload.github.com/withbuildthings/buildthings-gunny-arcade/tar.gz/${SNAPSHOT}`, { signal });
  if (!response.ok) throw new Error(`Pinned snapshot unavailable: HTTP ${response.status}`);
  const packed = await boundedBytes(response, MAX_SOURCE_BYTES), tar = gunzipSync(packed, { maxOutputLength: MAX_SOURCE_BYTES });
  const result: FileMap = {};
  const prefix = `buildthings-gunny-arcade-${SNAPSHOT}/`;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number): string => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(text(124, 12).trim() || "0", 8), type = text(156, 1), name = text(0, 100), extraPrefix = text(345, 155);
    const full = extraPrefix ? `${extraPrefix}/${name}` : name;
    let checksum = 0; for (let n = 0; n < 512; n++) checksum += n >= 148 && n < 156 ? 32 : header[n]!;
    if (checksum !== Number.parseInt(text(148, 8).trim(), 8) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || offset + 512 + size > tar.length) throw new Error("Invalid snapshot tar");
    // GitHub archives can contain a global PAX commit header; it is metadata, never extracted.
    if (type !== "g") {
      if (!full.startsWith(prefix)) throw new Error("Unexpected pinned snapshot root");
      const path = full.slice(prefix.length).replace(/\/$/, "");
      if ((type === "0" || type === "") && path) {
        if (!safePath(path) || path in result) throw new Error("Unsafe snapshot tar path");
        result[path] = tar.subarray(offset + 512, offset + 512 + size).toString("base64");
      } else if (type !== "5") throw new Error("Snapshot symlink or unsupported tar entry");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!result["src/main.cpp"] || !result["platformio.ini"] || !result["diagram.json"]) throw new Error("Incomplete pinned snapshot");
  return result;
}

export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("Response exceeds byte limit"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
