'use strict';
// PNG <-> ccv3 card codec. Only the ccv3 tEXt chunk is rewritten;
// every other chunk (including the image) is copied byte-for-byte.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { crc32 } = require('node:zlib');

function chunks(buffer) {
  const out = [];
  let i = 8;
  while (i < buffer.length) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.toString('ascii', i + 4, i + 8);
    const next = i + 12 + length;
    out.push({ start: i, end: next, type, data: buffer.subarray(i + 8, next - 4), raw: buffer.subarray(i, next) });
    i = next;
  }
  return out;
}

function readCard(pngPath) {
  const buffer = fs.readFileSync(pngPath);
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('not a PNG: ' + pngPath);
  }
  const found = [];
  for (const c of chunks(buffer)) {
    if (c.type === 'tEXt' && c.data.subarray(0, 5).equals(Buffer.from('ccv3\0'))) {
      const card = JSON.parse(Buffer.from(c.data.subarray(5).toString(), 'base64'));
      found.push({ chunk: c, card });
    }
  }
  if (found.length !== 1) throw new Error('expected exactly one ccv3 tEXt chunk, got ' + found.length);
  return { buffer, ...found[0] };
}

function buildChunk(card) {
  const payload = Buffer.from('ccv3\0' + Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'ascii');
  const out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length, 0);
  out.write('tEXt', 4, 'ascii');
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}

function writeCard(originalBuffer, targetChunk, card, outPath) {
  // Reassemble by walking the original chunk table; only the ccv3 chunk is swapped.
  const list = chunks(originalBuffer);
  const assembled = [originalBuffer.subarray(0, 8)];
  let replaced = 0;
  for (const c of list) {
    if (c.start === targetChunk.start) {
      assembled.push(buildChunk(card));
      replaced++;
    } else assembled.push(c.raw);
  }
  if (replaced !== 1) throw new Error('target chunk not found while rebuilding');
  fs.mkdirSync(require('node:path').dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(assembled));
  return Buffer.concat(assembled);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  return sha256(fs.readFileSync(p));
}

module.exports = { chunks, readCard, buildChunk, writeCard, sha256, sha256File };
