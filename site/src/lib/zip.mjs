// A ZIP writer, stored (uncompressed), in about sixty lines.
//
// No dependency, for the same reason favcon writes its own ICO container: the format's useful
// subset is small, and a library would be more bytes than the thing it packs. Every entry is
// STORE rather than DEFLATE because the payload is already PNG and SVG - deflating a zopflied
// PNG is work that returns nothing, and CompressionStream would make this async for no gain.
//
// Zip64 is not implemented. An icon set is kilobytes; if one ever exceeds 4 GB the throw below
// is the correct outcome.

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * `files` is [{ name, bytes }]. Returns a Uint8Array.
 *
 * The DOS timestamp is fixed rather than taken from the clock, so downloading the same mark
 * twice gives the same archive byte for byte - the same property the CLI's output has, and the
 * only part of it this page can honestly keep.
 */
export const zip = (files) => {
  const enc = new TextEncoder();
  const DOS_TIME = 0x0000, DOS_DATE = 0x2100;   // 1 Jan 1980, midnight
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, bytes } of files) {
    if (bytes.length > 0xffffffff) throw new Error(`${name} is too large for a zip32 entry`);
    const nameBytes = enc.encode(name);
    const sum = crc32(bytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);          // local file header signature
    lv.setUint16(4, 20, true);                  // version needed: 2.0
    lv.setUint16(6, 0, true);                   // flags: none (no data descriptor, no UTF-8 bit
    lv.setUint16(8, 0, true);                   //        needed - every name here is ASCII)
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, bytes.length, true);       // compressed == uncompressed under STORE
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);                  // extra field length
    local.set(nameBytes, 30);
    locals.push(local, bytes);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);          // central directory signature
    dv.setUint16(4, 20, true);                  // version made by
    dv.setUint16(6, 20, true);                  // version needed
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(16, sum, true);
    dv.setUint32(20, bytes.length, true);
    dv.setUint32(24, bytes.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);             // where this entry's local header starts
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + bytes.length;
  }

  const centralSize = central.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);            // end of central directory
  ev.setUint16(8, files.length, true);          // entries on this disk
  ev.setUint16(10, files.length, true);         // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);               // where the central directory starts

  const parts = [...locals, ...central, end];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
