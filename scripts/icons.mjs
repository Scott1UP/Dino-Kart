// Makes the app's icons and its link-preview picture from art that is already in the project.
//
//   npm run icons
//
//   public/favicon.ico            16, 32 and 48 pixel browser tab icon
//   public/icon-192.png           home-screen icons for Android (see public/manifest.webmanifest)
//   public/icon-512.png
//   public/icon-maskable-512.png  the same, filling the whole square so Android can cut its own shape
//   public/apple-touch-icon.png   home-screen icon for iPhones and iPads
//   public/og.jpg                 the picture shown when a link to the game is shared
//   android/app/src/main/res/mipmap-*/   launcher icons for the Android app
//
// The icon is Rex's profile picture on the game's sky blue. It is drawn from the full-size
// drawing in art/raw/ when that is there, and from the packed one in public/sprites/ otherwise.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const SKY_TOP = '#3bb4f6';
const SKY_BOTTOM = '#2f7fe0';
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

const rawFace = join(root, 'art/raw/rex/avatar.png');
const faceArt = await sharp(existsSync(rawFace) ? rawFace : join(pub, 'sprites/avatar-rex.png'))
  .trim()
  .png()
  .toBuffer();

/**
 * A square icon: the face on a sky-blue tile.
 * `corner` rounds the tile (as a fraction of its size); `face` is how much of the tile the face fills.
 */
async function icon(size, { corner = 0, face = 0.8 } = {}) {
  const tile = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${SKY_TOP}"/><stop offset="1" stop-color="${SKY_BOTTOM}"/>
      </linearGradient></defs>
      <rect width="${size}" height="${size}" rx="${size * corner}" fill="url(#sky)"/>
    </svg>`,
  );
  const inner = Math.round(size * face);
  const head = await sharp(faceArt).resize(inner, inner, { fit: 'contain', background: CLEAR }).png().toBuffer();
  return sharp(tile).composite([{ input: head }]).png().toBuffer();
}

/** An .ico file holding the given PNG pictures (each one square, and smaller than 256 pixels). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, n) => {
    const at = 6 + 16 * n;
    header.writeUInt8(size, at);
    header.writeUInt8(size, at + 1);
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

async function write(name, data) {
  await writeFile(join(pub, name), data);
  console.log(`wrote public/${name}`);
}

// The tab icon is a rounded tile, with the face nearly filling it so it still reads at 16 pixels.
const tab = { corner: 0.22, face: 0.9 };
await write(
  'favicon.ico',
  ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await icon(size, tab) })))),
);
await write('icon-192.png', await icon(192, { corner: 0.22, face: 0.84 }));
await write('icon-512.png', await icon(512, { corner: 0.22, face: 0.84 }));
// Android may crop a maskable icon to a circle 80% of its width, so the face stays inside that.
await write('icon-maskable-512.png', await icon(512, { face: 0.62 }));
// iOS rounds the corners itself, and shows black wherever an icon is see-through.
await write('apple-touch-icon.png', await icon(180, { face: 0.8 }));

// The Android app's launcher icons, one set for each screen density. Newer Android draws the
// "foreground" picture over a plain colour (res/values/ic_launcher_background.xml) and cuts its own
// shape out of the middle, so the face sits well inside it. The other two are for older Android.
const res = join(root, 'android/app/src/main/res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, scale] of Object.entries(densities)) {
  const size = 48 * scale;
  const full = 108 * scale;
  const inner = Math.round(full * 0.52);
  const pad = Math.round((full - inner) / 2);
  const files = {
    'ic_launcher.png': await icon(size, { corner: 0.22, face: 0.84 }),
    'ic_launcher_round.png': await icon(size, { corner: 0.5, face: 0.7 }),
    'ic_launcher_foreground.png': await sharp(faceArt)
      .resize(inner, inner, { fit: 'contain', background: CLEAR })
      .extend({ top: pad, bottom: full - inner - pad, left: pad, right: full - inner - pad, background: CLEAR })
      .png()
      .toBuffer(),
  };
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(res, `mipmap-${density}`, name), data);
    console.log(`wrote android/app/src/main/res/mipmap-${density}/${name}`);
  }
}

// The link preview: the logo over the Dino Falls cover. The cover is smaller than the picture,
// so it is softened on purpose, like a background out of focus.
const OG_W = 1200;
const OG_H = 630;
const backdrop = await sharp(join(pub, 'covers/dino-falls.jpg'))
  .resize(OG_W, OG_H, { fit: 'cover' })
  .blur(4)
  .toBuffer();
const logo = await sharp(join(pub, 'logo.png'))
  .resize(OG_W - 240, OG_H - 90, { fit: 'inside' })
  .png()
  .toBuffer();
// A soft dark copy of the logo underneath itself, to lift it off the background.
const shadow = await sharp(logo)
  .ensureAlpha()
  .linear([0, 0, 0, 0.45], [20, 40, 70, 0])
  .extend({ top: 40, bottom: 40, left: 40, right: 40, background: CLEAR })
  .blur(14)
  .toBuffer();
const { width: logoW, height: logoH } = await sharp(logo).metadata();
const left = Math.round((OG_W - logoW) / 2);
const top = Math.round((OG_H - logoH) / 2);
await write(
  'og.jpg',
  await sharp(backdrop)
    .composite([
      { input: shadow, left: left - 40, top: top - 40 + 12 },
      { input: logo, left, top },
    ])
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer(),
);
