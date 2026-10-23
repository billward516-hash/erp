import { inflateRawSync } from 'node:zlib';
import { invalid } from '../errors.js';

/**
 * A small zip reader for uploads: stored and deflated entries, no encryption, no zip64. Reads the central directory, so
 * archives written by any tool work. Limits guard against zip bombs: entry count, size of one entry and of everything.
 */
export interface ZipEntry { name: string; content: Buffer }

export function readZip(buf: Buffer, limits: { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 3000; const maxEntry = limits.maxEntryBytes ?? 100 * 1024 * 1024; const maxTotal = limits.maxTotalBytes ?? 400 * 1024 * 1024;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw invalid('this is not a zip file (or it is damaged)');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw invalid('zip64 archives are not supported; split the files into smaller zips');
  if (count > maxEntries) throw invalid(`the zip holds ${count} entries; at most ${maxEntries} at a time`);
  const out: ZipEntry[] = []; let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw invalid('the zip directory is damaged');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32); const local = buf.readUInt32LE(p + 42);
    const name = buf.toString((flags & 0x800) ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw invalid(`"${name}" is password protected; remove the password and zip again`);
    if (/(^|\/)\.\.(\/|$)|^\/|\\/.test(name)) throw invalid(`"${name}" has an unsafe path`);
    if (usize > maxEntry) throw invalid(`"${name}" is larger than ${Math.round(maxEntry / 1048576)} MB`);
    total += usize; if (total > maxTotal) throw invalid('the files in the zip are too large in total');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw invalid('the zip is damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) { try { content = inflateRawSync(raw, { maxOutputLength: maxEntry }); } catch { throw invalid(`"${name}" could not be unpacked`); } }
    else throw invalid(`"${name}" uses a compression method that is not supported`);
    out.push({ name: name.replace(/^\.\//, ''), content });
  }
  return out;
}
