import { boundedBytes, HttpError, requireCondition, sha256 } from './types.ts';
import { archiveManifestSchema } from '../../../packages/contracts/src/index.ts';

export const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

export function safePath(path: string): string {
  requireCondition(typeof path === 'string' && path.length > 0 && path.length <= 500 && !/[\\\x00-\x1f:]/.test(path) && !path.startsWith('/') && !path.endsWith('/'), 400, 'unsafe_archive_path');
  const parts = path.split('/');
  requireCondition(!parts.some(part => part === '..' || part === '.' || !part || part.normalize('NFC') !== part), 400, 'unsafe_archive_path');
  requireCondition(!parts.some(part => /^(?:\.env(?:\..*)?|\.git|\.aws|\.ssh|\.codex|\.agents|node_modules|\.pio|\.cache|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part)), 400, 'excluded_archive_path');
  return path;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(data: Uint8Array<ArrayBuffer>, format: 'deflate' | 'deflate-raw', max: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
    return await boundedBytes(new Request('https://archive.invalid', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), max);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_compressed_data');
  }
}

export async function readZip(bytes: Uint8Array<ArrayBuffer>): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  requireCondition(bytes.length <= MAX_ARCHIVE && bytes.length >= 22, 400, 'invalid_zip');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  requireCondition(end >= 0, 400, 'invalid_zip_directory');
  const count = view.getUint16(end + 10, true);
  requireCondition(count > 0 && count <= MAX_FILES && view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0 && view.getUint16(end + 8, true) === count, 400, 'unsupported_zip');
  const directorySize = view.getUint32(end + 12, true);
  let position = view.getUint32(end + 16, true);
  const directoryStart = position;
  requireCondition(directoryStart + directorySize === end, 400, 'invalid_zip_directory');
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const intervals: [number, number][] = [];
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    requireCondition(position + 46 <= end && view.getUint32(position, true) === 0x02014b50, 400, 'invalid_zip_entry');
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const checksum = view.getUint32(position + 16, true);
    const compressed = view.getUint32(position + 20, true);
    const uncompressed = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const attributes = view.getUint32(position + 38, true);
    const local = view.getUint32(position + 42, true);
    const mode = attributes >>> 16 & 0xf000;
    requireCondition((flags & ~0x808) === 0 && (method === 0 || method === 8) && (mode === 0 || mode === 0x8000) && !(attributes & 0x10) && view.getUint16(position + 34, true) === 0, 400, 'unsupported_zip_entry');
    requireCondition(position + 46 + nameLength + extraLength + commentLength <= end && local + 30 <= directoryStart, 400, 'invalid_zip_entry');
    const path = safePath(decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength)));
    requireCondition(!files.has(path), 400, 'duplicate_archive_path');
    requireCondition(view.getUint32(local, true) === 0x04034b50 && view.getUint16(local + 6, true) === flags && view.getUint16(local + 8, true) === method, 400, 'zip_header_mismatch');
    const localNameLength = view.getUint16(local + 26, true);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    requireCondition(start + compressed <= directoryStart && decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) === path, 400, 'zip_header_mismatch');
    if (!(flags & 8)) requireCondition(view.getUint32(local + 14, true) === checksum && view.getUint32(local + 18, true) === compressed && view.getUint32(local + 22, true) === uncompressed, 400, 'zip_header_mismatch');
    const entryEnd = start + compressed;
    requireCondition(!intervals.some(([a, b]) => local < b && entryEnd > a), 400, 'overlapping_zip_entries');
    intervals.push([local, entryEnd]);
    expanded += uncompressed;
    requireCondition(expanded <= MAX_EXPANDED && uncompressed <= MAX_ARCHIVE, 413, 'archive_expanded_limit');
    const packed = bytes.slice(start, entryEnd);
    const unpacked = method === 0 ? packed : await inflate(packed, 'deflate-raw', Math.min(uncompressed + 1, MAX_ARCHIVE));
    requireCondition(unpacked.length === uncompressed && crc32(unpacked) === checksum, 400, 'archive_checksum_mismatch');
    files.set(path, unpacked);
    position += 46 + nameLength + extraLength + commentLength;
  }
  requireCondition(position === end, 400, 'invalid_zip_directory');
  return files;
}

export async function validateArchive(bytes: Uint8Array<ArrayBuffer>): Promise<{ manifest: any; files: Map<string, Uint8Array<ArrayBuffer>> }> {
  const files = await readZip(bytes);
  const manifestBytes = files.get('manifest.json');
  requireCondition(manifestBytes && manifestBytes.length <= 4 * 1024 * 1024, 400, 'manifest_required');
  let manifest: any;
  try { manifest = archiveManifestSchema.parse(JSON.parse(decoder.decode(manifestBytes))); } catch { throw new HttpError(400, 'invalid_manifest'); }
  requireCondition(manifest?.format === 'hardwire-archive' && manifest.formatVersion === 1 && typeof manifest.project?.name === 'string' && manifest.project.name.length > 0 && Array.isArray(manifest.tasks) && Array.isArray(manifest.runs) && Array.isArray(manifest.files) && Number.isFinite(Date.parse(manifest.createdAt)), 400, 'invalid_manifest');
  requireCondition(manifest.project.sourceCommit === null || /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(manifest.project.sourceCommit), 400, 'invalid_manifest');
  const paths = new Set<string>();
  for (const entry of manifest.files) {
    const path = safePath(entry.path);
    requireCondition(path !== 'manifest.json' && !paths.has(path) && Number.isSafeInteger(entry.byteSize) && entry.byteSize >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256) && typeof entry.mediaType === 'string', 400, 'invalid_manifest_entry');
    paths.add(path);
    const file = files.get(path);
    requireCondition(file && file.length === entry.byteSize && await sha256(file) === entry.sha256, 400, 'archive_manifest_mismatch');
  }
  requireCondition(files.size === paths.size + 1, 400, 'unlisted_archive_file');
  files.delete('manifest.json');
  return { manifest, files };
}

export function writeZip(files: Map<string, Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> {
  requireCondition(files.size > 0 && files.size <= MAX_FILES, 413, 'archive_file_limit');
  let localSize = 0, centralSize = 0;
  const entries = [...files].map(([path, data]) => ({ name: encoder.encode(safePath(path)), data, crc: crc32(data) }));
  for (const entry of entries) { localSize += 30 + entry.name.length + entry.data.length; centralSize += 46 + entry.name.length; }
  requireCondition(localSize + centralSize + 22 <= MAX_ARCHIVE, 413, 'archive_size_limit');
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let local = 0, central = localSize;
  for (const { name, data, crc } of entries) {
    view.setUint32(local, 0x04034b50, true); view.setUint16(local + 4, 20, true); view.setUint16(local + 6, 0x800, true);
    view.setUint32(local + 14, crc, true); view.setUint32(local + 18, data.length, true); view.setUint32(local + 22, data.length, true); view.setUint16(local + 26, name.length, true);
    output.set(name, local + 30); output.set(data, local + 30 + name.length);
    view.setUint32(central, 0x02014b50, true); view.setUint16(central + 4, 0x0314, true); view.setUint16(central + 6, 20, true); view.setUint16(central + 8, 0x800, true);
    view.setUint32(central + 16, crc, true); view.setUint32(central + 20, data.length, true); view.setUint32(central + 24, data.length, true);
    view.setUint16(central + 28, name.length, true); view.setUint32(central + 38, 0x81a40000, true); view.setUint32(central + 42, local, true);
    output.set(name, central + 46);
    local += 30 + name.length + data.length; central += 46 + name.length;
  }
  view.setUint32(central, 0x06054b50, true); view.setUint16(central + 8, entries.length, true); view.setUint16(central + 10, entries.length, true);
  view.setUint32(central + 12, centralSize, true); view.setUint32(central + 16, localSize, true);
  return output;
}

export async function validatePng(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  requireCondition(bytes.length > 45 && bytes.slice(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i]), 422, 'invalid_png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 8, width = 0, height = 0, channels = 0, ended = false;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position);
    requireCondition(position + 12 + length <= bytes.length, 422, 'invalid_png');
    const type = new TextDecoder().decode(bytes.subarray(position + 4, position + 8));
    requireCondition(crc32(bytes.subarray(position + 4, position + 8 + length)) === view.getUint32(position + 8 + length), 422, 'invalid_png_crc');
    if (position === 8) {
      requireCondition(type === 'IHDR' && length === 13, 422, 'invalid_png');
      width = view.getUint32(position + 8); height = view.getUint32(position + 12);
      const color = bytes[position + 17]; channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
      requireCondition(width > 0 && height > 0 && width <= 4096 && height <= 4096 && channels > 0 && bytes[position + 16] === 8 && bytes[position + 18] === 0 && bytes[position + 19] === 0 && bytes[position + 20] === 0, 422, 'unsupported_png_encoding');
    } else requireCondition(type !== 'IHDR', 422, 'invalid_png');
    if (type === 'IDAT') chunks.push(bytes.slice(position + 8, position + 8 + length));
    if (type === 'IEND') { requireCondition(length === 0 && position + 12 === bytes.length, 422, 'invalid_png'); ended = true; break; }
    position += 12 + length;
  }
  requireCondition(ended && chunks.length > 0 && (width * channels + 1) * height <= 32 * 1024 * 1024, 422, 'invalid_png');
  const packed = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0; for (const chunk of chunks) { packed.set(chunk, offset); offset += chunk.length; }
  const expected = (width * channels + 1) * height;
  const pixels = await inflate(packed, 'deflate', expected + 1);
  requireCondition(pixels.length === expected, 422, 'invalid_png_pixels');
  for (let row = 0; row < height; row++) requireCondition(pixels[row * (width * channels + 1)]! <= 4, 422, 'invalid_png_filter');
}
