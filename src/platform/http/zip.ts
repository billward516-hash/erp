import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A small ZIP writer (D-170): deflated entries with UTF-8 names, built in memory. Enough for an audit pack of reports and
 * released files; not a general archiver (no zip64: at most 65,535 files and 4 GB, both far above what a pack holds).
 */
export interface ZipEntry { name: string; data: Buffer; date?: Date }

export function zip(entries: ZipEntry[]): Buffer {
  if (entries.length > 65_000) throw new Error('too many files for a zip');
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const comp = deflateRawSync(e.data); const stored = comp.length < e.data.length;
    const body = stored ? comp : e.data; const method = stored ? 8 : 0;
    const d = e.date ?? new Date();
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    const day = (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const crc = crc32(e.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(day, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
