// Render assets/felyrics-icon.svg into a multi-size Windows ICO.
// One 32-bit PNG payload per size; run from the repository root with
// `npm run icon`. Deterministic: resvg output carries no timestamps.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SVG_PATH = path.join(ROOT, 'assets', 'felyrics-icon.svg');
const ICO_PATH = path.join(ROOT, 'assets', 'felyrics-icon.ico');

const svg = await readFile(SVG_PATH, 'utf8');

const frames = SIZES.map((size) => {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
  }).render();
  return { size, png: rendered.asPng() };
});

// ICONDIR: reserved (0), type (1 = icon), image count.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);

// ICONDIRENTRY: 16 bytes per image.
const directory = Buffer.alloc(16 * frames.length);
let offset = header.length + directory.length;
for (const [index, { size, png }] of frames.entries()) {
  const base = index * 16;
  directory.writeUInt8(size === 256 ? 0 : size, base); // width, 0 means 256
  directory.writeUInt8(size === 256 ? 0 : size, base + 1); // height
  directory.writeUInt8(0, base + 2); // palette entries
  directory.writeUInt8(0, base + 3); // reserved
  directory.writeUInt16LE(1, base + 4); // color planes
  directory.writeUInt16LE(32, base + 6); // bits per pixel
  directory.writeUInt32LE(png.length, base + 8); // payload bytes
  directory.writeUInt32LE(offset, base + 12); // payload offset
  offset += png.length;
}

const ico = Buffer.concat([header, directory, ...frames.map(({ png }) => png)]);
await writeFile(ICO_PATH, ico);
console.log(
  `wrote ${path.relative(ROOT, ICO_PATH)} (${ico.length} bytes, ${SIZES.join(', ')} px)`,
);
