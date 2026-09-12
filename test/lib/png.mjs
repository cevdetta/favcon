// A PNG reader in terms of node:zlib and nothing else.
//
// The suite used to shell out to ImageMagick for this. It cannot any more: ImageMagick is no
// longer preinstalled on ubuntu-24.04, and apt's version is IM6, whose binary is `convert`
// rather than `magick` - so a shell suite fails on a fresh runner in a way that looks like a
// favcon bug and is not. Everything here needs is IHDR arithmetic and one inflate.
//
// Adam7 is deliberately unsupported: nothing in the pipeline emits an interlaced PNG (oxipng
// only writes one if asked), so supporting it would be untested code standing in for a
// clear error.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Split a PNG into its chunks. Returns { type -> Buffer[] } plus the IHDR fields. */
export function chunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const out = new Map();
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (!out.has(type)) out.set(type, []);
    out.get(type).push(data);
    i += 12 + len;                       // length + type + data + CRC
    if (type === 'IEND') break;
  }
  return out;
}

/** IHDR only - cheap, and enough for a dimensions assertion. */
export function header(buf) {
  const ihdr = chunks(buf).get('IHDR')?.[0];
  if (!ihdr) throw new Error('no IHDR');
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    depth: ihdr[8],
    colorType: ihdr[9],
    interlace: ihdr[12],
  };
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode to 8-bit RGBA, one Uint8Array of width*height*4.
 *
 * Indexed and greyscale inputs are expanded, and tRNS is applied, because the pipeline picks
 * whichever encoding is smallest per file: the same mark can come out 4-bit indexed at 32 px
 * and 8-bit RGBA at 512 px, and the accuracy gate has to compare them to the same reference.
 */
export function decode(buf) {
  const h = header(buf);
  if (h.interlace !== 0) throw new Error('interlaced PNG is not supported');
  const chs = CHANNELS[h.colorType];
  if (!chs) throw new Error(`unsupported colour type ${h.colorType}`);

  const cs = chunks(buf);
  const raw = inflateSync(Buffer.concat(cs.get('IDAT') ?? []));
  const plte = cs.get('PLTE')?.[0];
  const trns = cs.get('tRNS')?.[0];

  const bpp = Math.max(1, (chs * h.depth) >> 3);       // filters work on whole bytes
  const rowBytes = Math.ceil((chs * h.depth * h.width) / 8);
  const out = new Uint8Array(h.width * h.height * 4);

  let prev = new Uint8Array(rowBytes);
  let pos = 0;
  for (let y = 0; y < h.height; y++) {
    const filter = raw[pos++];
    const line = Uint8Array.prototype.slice.call(raw, pos, pos + rowBytes);
    pos += rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`unknown filter ${filter} on row ${y}`);
    }
    prev = line;

    // Sub-byte depths are read most-significant-bit first, which is also the order the
    // samples appear in, so the shift counts down.
    const sample = (idx) => {
      if (h.depth === 8) return line[idx];
      if (h.depth === 16) return line[idx * 2];              // drop the low byte
      const per = 8 / h.depth;
      const byte = line[Math.floor(idx / per)];
      const shift = 8 - h.depth * ((idx % per) + 1);
      return (byte >> shift) & ((1 << h.depth) - 1);
    };
    const scale = h.depth < 8 ? 255 / ((1 << h.depth) - 1) : 1;

    for (let x = 0; x < h.width; x++) {
      const o = (y * h.width + x) * 4;
      if (h.colorType === 3) {
        const idx = sample(x);
        out[o] = plte[idx * 3]; out[o + 1] = plte[idx * 3 + 1]; out[o + 2] = plte[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (h.colorType === 0 || h.colorType === 4) {
        const g = Math.round(sample(x * chs) * scale);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = h.colorType === 4 ? Math.round(sample(x * chs + 1) * scale) : 255;
      } else {
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(sample(x * chs + c) * scale);
        out[o + 3] = h.colorType === 6 ? Math.round(sample(x * chs + 3) * scale) : 255;
      }
      // Greyscale and truecolour carry transparency as one "this exact value is clear" entry.
      if (trns && (h.colorType === 0 || h.colorType === 2)) {
        const key = h.colorType === 0
          ? [trns.readUInt16BE(0)]
          : [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)];
        const hit = h.colorType === 0
          ? sample(x) === key[0]
          : [0, 1, 2].every((c) => sample(x * chs + c) === key[c]);
        if (hit) out[o + 3] = 0;
      }
    }
  }
  return { width: h.width, height: h.height, data: out };
}

/**
 * Build a PNG. Used only to synthesise the deliberately-wrong images the suite needs - a
 * 31x31 icon, a stretched one - which is cheaper and more exact than trying to make the
 * pipeline produce them.
 */
export function encode({ width, height, data }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                        // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE, chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
