import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const tag = Buffer.from(type), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); tag.copy(result, 4); data.copy(result, 8);
  let crc = 0xffffffff; for (const byte of Buffer.concat([tag, data])) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}

/** Only the visible QQ login window is returned, never an entire desktop. */
export function findQQLoginWindow(tree) {
  const rows = String(tree).split('\n').flatMap(line => {
    const match = /^\s*(0x[0-9a-f]+) "(?:QQ|QQ登录|QQ Login)":.*?\s(\d+)x(\d+)[+-]\d+[+-]\d+\s+([+-]\d+)([+-]\d+)\s*$/i.exec(line);
    if (!match) return [];
    const [width,height,x,y] = match.slice(2).map(Number);
    // This deployment pins the QQ image whose login window is 320 x 460.
    // Main chat windows and dialogs must never be substituted as login pictures.
    return width === 320 && height === 460 && x >= 0 && y >= 0 ? [{ id: match[1], x, y, width, height }] : [];
  });
  return rows.sort((a,b) => a.width * a.height - b.width * b.height)[0] || null;
}

export function loginWindowPng(image, crop) {
  if (!Buffer.isBuffer(image) || image.length < 104 || image.length > 12 * 1024 * 1024) throw Error('Invalid X11 frame');
  const field = index => image.readUInt32BE(index * 4);
  const header = field(0), width = field(4), height = field(5), order = field(7), bits = field(11), stride = field(12), colors = field(19), start = header + colors * 12;
  if (field(1) !== 7 || field(2) !== 2 || ![0,1].includes(order) || ![24,32].includes(bits) || header < 100 || width > 4096 || height > 4096
      || stride < width * bits / 8 || stride > 32768 || start + stride * height > image.length || field(14) !== 0xff0000 || field(15) !== 0xff00 || field(16) !== 0xff) throw Error('Unsupported X11 frame');
  if (!crop || !['x','y','width','height'].every(k => Number.isInteger(crop[k])) || crop.x < 0 || crop.y < 0
      || crop.width < 1 || crop.height < 1 || crop.x + crop.width > width || crop.y + crop.height > height) throw Error('Invalid QQ window bounds');
  const raw = Buffer.alloc((crop.width * 3 + 1) * crop.height), bytes = bits / 8;
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
    const source = start + (crop.y + y) * stride + (crop.x + x) * bytes, target = y * (crop.width * 3 + 1) + 1 + x * 3;
    if (order === 0) { raw[target] = image[source + 2]; raw[target + 1] = image[source + 1]; raw[target + 2] = image[source]; }
    else { const offset = bytes === 4 ? 1 : 0; raw[target] = image[source + offset]; raw[target + 1] = image[source + offset + 1]; raw[target + 2] = image[source + offset + 2]; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(crop.width); ihdr.writeUInt32BE(crop.height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',ihdr), chunk('IDAT',deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]);
}
