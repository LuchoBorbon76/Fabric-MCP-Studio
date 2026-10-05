// Minimal ZIP reader for uploaded Power BI files (.pbit, .pbix and zipped Power BI projects). Reads the central
// directory (ZIP64 included) and inflates only the entries asked for, so a large .pbix data model is never unpacked.
import { inflateRawSync } from 'node:zlib';

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

const u64 = (buf, at) => {
  const n = buf.readBigUInt64LE(at);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('The file is too large to read.');
  return Number(n);
};

/** True when the bytes look like a ZIP archive. */
export const isZip = (buf) => buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50;

/**
 * Open a ZIP held in memory. Returns { names, has(name), size(name), read(name, { maxBytes }) }.
 * Names are the stored paths with forward slashes.
 */
export function openZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw fail('The file isn\'t a valid ZIP package (no central directory).');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) throw fail('The ZIP64 directory is missing.');
    const rec = u64(buf, loc + 8);
    if (rec + 56 > buf.length || buf.readUInt32LE(rec) !== 0x06064b50) throw fail('The ZIP64 directory is damaged.');
    count = u64(buf, rec + 32);
    cdSize = u64(buf, rec + 40);
    cdOffset = u64(buf, rec + 48);
  }
  if (cdOffset + cdSize > buf.length) throw fail('The ZIP package is truncated.');
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail('The ZIP directory is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(buf, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(buf, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(buf, q); }
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) entries.set(name, { name, method, compSize, size, offset, encrypted: Boolean(flags & 1) });
    p = xEnd + commentLen;
  }

  const read = (name, { maxBytes = 64 * 1024 * 1024 } = {}) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.encrypted) throw fail(`${name} is encrypted.`);
    if (e.size > maxBytes) throw fail(`${name} is larger than ${Math.round(maxBytes / 1048576)} MB.`);
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw fail(`${name} is damaged.`);
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    if (start + e.compSize > buf.length) throw fail(`${name} is truncated.`);
    const data = buf.subarray(start, start + e.compSize);
    // A stored entry must be exactly as long as it says, so the declared sizes the callers check can be trusted.
    if (e.method === 0) {
      if (e.compSize !== e.size) throw fail(`${name} is damaged (its sizes don't match).`);
      return Buffer.from(data);
    }
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) + 1024 });
    throw fail(`${name} uses an unsupported compression method (${e.method}).`);
  };

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    size: (name) => entries.get(name)?.size ?? 0,
    read,
  };
}

/** Decode text stored as UTF-8 or UTF-16 (Power BI Desktop writes Report/Layout and DataModelSchema as UTF-16LE). */
export function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  return buf.toString('utf8');
}
