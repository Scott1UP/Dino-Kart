// Racer sprite pipeline. Run through npm so the API key is loaded:
//
//   npm run sprites -- ref rex      generate the design reference for one racer
//   npm run sprites -- tweak rex "..."   redraw the reference with one change, keeping the rest
//   npm run sprites -- sheet rex    generate the 16-view, full 360 turnaround sheet from that reference
//   npm run sprites -- avatar       generate (if missing) + pack every racer's profile picture
//   npm run sprites -- pack         slice every sheet into public/sprites/<id>.png + .json
//   npm run sprites -- logo         generate (if missing) + pack the title logo; "logo new" redraws it
//   npm run sprites -- scenery      generate (if missing) + pack the trackside scenery sheet
//   npm run sprites -- items        the same for the item sheet
//   npm run sprites -- items new items2   regenerate one part of a sheet (see OBJECT_SHEETS)
//   npm run sprites -- all          ref + sheet for racers that are missing them, then pack
//
// Raw model output is kept in art/raw/ so `pack` can be re-run for free.

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'art', 'raw');
const OUT = path.join(ROOT, 'public', 'sprites');

const MODEL = process.env.SPRITE_MODEL ?? 'gpt-image-2.6-sunburst';
const QUALITY = process.env.SPRITE_QUALITY ?? 'high';

/** Size of one packed frame, in pixels. */
const CELL_W = 256;
const CELL_H = 320;
const CELL_PAD = 4;
/** Frames per row on a packed racer sheet. */
const ATLAS_COLS = 8;
/**
 * Every racer is scaled so its kart comes out this size, in pixels, whatever
 * the driver looks like (see `pack`). A tall driver just uses more of the cell.
 */
const KART_PX = 160;

const STYLE = [
  'Style: a sprite from a mid-1990s 3D kart racing video game, pre-rendered CGI look:',
  'smooth rounded shapes, soft glossy shading like a vinyl toy, bright saturated colours,',
  'soft studio light from above, no outlines.',
  'A cute, friendly, chubby cartoon dinosaur with a big head, for young children. Its eyes are small,',
  'round, dark and set apart on the sides of its head. An original character design that does not',
  'resemble any existing video game, film or cartoon character.',
  'It sits in a small low go-kart with four fat black tyres, a visible steering wheel and a small engine at the back.',
  'The whole kart and driver are fully visible and centred. Fully transparent background.',
  'No ground, no cast shadow, no text, no border, no extra objects.',
].join(' ');

export const RACERS = {
  rex: {
    name: 'Rex',
    design:
      'A teal-blue baby T-rex with dark navy stripes across its back and tail, a pale yellow belly, ' +
      'a big boxy square-jawed head with little brow ridges and a few small rounded teeth showing in a grin, ' +
      'tiny two-fingered arms holding the steering wheel. It has no visible tail: nothing pokes out of or ' +
      'through the seat. ' +
      'Its go-kart is red and themed like a T-rex: the front bumper is a chunky open dinosaur jaw with a row of ' +
      'big rounded white teeth, the rear has two short bone-white exhaust pipes, one on each side of the engine, ' +
      'and the wheel hubs are white.',
  },
  trike: {
    name: 'Trixie',
    design:
      'A magenta-pink baby triceratops with a big round neck frill edged in cream scallops, three small ' +
      'rounded cream horns and a little beak. ' +
      'Its go-kart is yellow and themed like a triceratops: two big curved cream horns stick forward from the ' +
      'front corners of the kart like bull horns. The engine is a single grey block at the very back end of the ' +
      'kart, behind the seat, with a small scalloped frill-shaped yellow spoiler mounted directly on top of it. ' +
      'There is exactly one exhaust pipe: a short stubby pipe sticking straight out of the back face of the ' +
      'engine, pointing backwards, so it can only be seen from behind or from the side, never from the front. ' +
      'Nothing sits between the seat and the engine. The wheel hubs are white.',
  },
  stego: {
    name: 'Spike',
    design:
      'An orange baby stegosaurus with a row of big rounded teal plates down its back, a small head with a ' +
      'gentle smile, and a short tail. ' +
      'Its go-kart is blue and themed like a stegosaurus: a row of rounded teal plates runs along the top of each ' +
      'side panel, and one big rounded teal plate stands upright on the centre of the nose of the kart like a ' +
      'hood ornament. The kart has its own short stubby tail, made of the same glossy blue bodywork as the kart, ' +
      'sticking out of the back above a single central exhaust pipe, with four small rounded green spikes on its ' +
      'tip. The kart tail is blue, never orange: it is part of the kart, not part of the dinosaur. ' +
      'The wheel hubs are white.',
  },
  raptor: {
    name: 'Zip',
    design:
      'A sunny yellow baby velociraptor with a slim body, a long narrow snout with a cheeky grin, a tuft of ' +
      'orange feathers on top of its head and along its forearms, and small clawed hands holding the steering ' +
      'wheel. It has no visible tail: nothing pokes out of or through the seat. ' +
      'Its go-kart is purple and themed like a raptor: sleek, low and pointed at the nose like an arrowhead, ' +
      'with one big curved cream sickle claw sticking forward from each front corner, and a fan of orange ' +
      'feathers standing up as a spoiler on top of the engine at the very back. There is exactly one exhaust ' +
      'pipe, sticking straight out of the back face of the engine and pointing backwards. The wheel hubs are white.',
  },
  brachio: {
    name: 'Bree',
    design:
      'A sky-blue baby brachiosaurus with a long neck held straight upright (the neck is about as long as its ' +
      'body is tall), a small round head with a gentle smile and a little bump on its forehead, a cream belly ' +
      'and a few darker blue spots on its back. Its front feet hold the steering wheel. It has no visible tail: ' +
      'nothing pokes out of or through the seat. ' +
      'Its go-kart is leaf-green and themed like a jungle treetop: sturdy and rounded, with a chunky wooden log ' +
      'as the front bumper, and a bunch of big bright green leaves fanned out as a spoiler on top of the engine ' +
      'at the very back. There is exactly one exhaust pipe, sticking straight out of the back face of the engine ' +
      'and pointing backwards. The wheel hubs are white.',
  },
  ptero: {
    name: 'Skye',
    design:
      'A red-orange baby pteranodon with a long pointed crest sweeping back from its head, a long toothless ' +
      'cream beak with a happy smile, a cream chest, and small wings folded at its sides with little hands ' +
      'holding the steering wheel. It has no visible tail: nothing pokes out of or through the seat. ' +
      'Its go-kart is turquoise and themed like a little aeroplane: the nose is a pointed cream beak-shaped ' +
      'cone, one short stubby rounded wing sticks out of each side panel just behind the front wheels, and an ' +
      'upright turquoise tail fin stands on top of the engine at the very back. There is exactly one exhaust ' +
      'pipe, sticking straight out of the back face of the engine and pointing backwards. The wheel hubs are white.',
  },
};

/**
 * The 16 views on a turnaround sheet, in reading order (4 columns x 4 rows): a
 * full turn in 22.5 degree steps. 0 = seen from behind, positive = nose
 * pointing right on screen, 180 = from the front, negative = nose pointing left.
 */
export const ANGLES = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, -157.5, -135, -112.5, -90, -67.5, -45, -22.5];
const COLS = 4;
const VIEWS = [
  'seen from directly behind (we see the back of the head and the engine)',
  'seen from behind, the kart turned slightly so its nose points a little to the RIGHT',
  'rear three-quarter view, nose pointing to the RIGHT and away from us',
  'almost a side view, nose pointing RIGHT, seen slightly from behind',
  'exact side profile, nose pointing to the RIGHT',
  'almost a side view, nose pointing RIGHT, seen slightly from the front',
  'front three-quarter view, nose pointing to the RIGHT and towards us',
  'seen from the front, the kart turned slightly so its nose points a little to the RIGHT',
  'seen from directly in front (we see the face)',
  'seen from the front, the kart turned slightly so its nose points a little to the LEFT',
  'front three-quarter view, nose pointing to the LEFT and towards us',
  'almost a side view, nose pointing LEFT, seen slightly from the front',
  'exact side profile, nose pointing to the LEFT',
  'almost a side view, nose pointing LEFT, seen slightly from behind',
  'rear three-quarter view, nose pointing to the LEFT and away from us',
  'seen from behind, the kart turned slightly so its nose points a little to the LEFT',
];

const exists = (p) => access(p).then(() => true, () => false);

async function openai(endpoint, body) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set (put it in .env.local)');
  const isForm = body instanceof FormData;
  const res = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
    body: isForm ? body : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`);
  return Buffer.from(json.data[0].b64_json, 'base64');
}

async function makeRef(id) {
  const racer = RACERS[id];
  const prompt =
    `${racer.design} Front three-quarter view, seen from slightly above. ${STYLE}`;
  console.log(`[${id}] generating reference with ${MODEL}...`);
  const png = await openai('images/generations', {
    model: MODEL,
    prompt,
    size: '1024x1024',
    quality: QUALITY,
    background: 'transparent',
    output_format: 'png',
  });
  await mkdir(path.join(RAW, id), { recursive: true });
  await writeFile(path.join(RAW, id, 'ref.png'), png);
  console.log(`[${id}] wrote art/raw/${id}/ref.png`);
}

async function makeSheet(id) {
  const racer = RACERS[id];
  const ref = await readFile(path.join(RAW, id, 'ref.png'));
  const prompt = [
    'A character turnaround sprite sheet of EXACTLY the character and go-kart in the reference image:',
    'same design, same colours, same proportions in every view.',
    `(${racer.design})`,
    'The sheet is a grid of 4 columns and 4 rows: 16 separate views, evenly spaced, with clear empty',
    'space between them so no view touches another. Every view is drawn at the same scale, the camera',
    'is always slightly above the kart looking down a little, and the kart always sits flat and level.',
    'Together the 16 views are one full 360-degree turntable rotation of the same solid object, in equal',
    'steps of 22.5 degrees: rows 1 and 2 turn the nose round to the right, from a rear view to a front',
    'view; rows 3 and 4 carry on round, with the nose pointing left, back to the rear view. The left-facing',
    'views show the real other side of the kart, with every detail where it physically belongs.',
    ...VIEWS.map((v, i) => `View ${i + 1} (row ${Math.floor(i / COLS) + 1}, column ${(i % COLS) + 1}): ${v}.`),
    STYLE,
  ].join(' ');

  const form = new FormData();
  form.set('model', MODEL);
  form.set('prompt', prompt);
  form.set('size', '2048x2048');
  form.set('quality', QUALITY);
  form.set('background', 'transparent');
  form.set('output_format', 'png');
  form.append('image[]', new Blob([ref], { type: 'image/png' }), 'ref.png');

  console.log(`[${id}] generating turnaround sheet with ${MODEL}...`);
  const png = await openai('images/edits', form);
  await writeFile(path.join(RAW, id, 'sheet.png'), png);
  console.log(`[${id}] wrote art/raw/${id}/sheet.png`);
}

/**
 * Redraw a racer's reference with a change applied, keeping everything else.
 * The previous reference is kept as ref.prev.png. Update the racer's `design`
 * text to match before regenerating its sheet.
 */
async function tweakRef(id, instruction) {
  const refPath = path.join(RAW, id, 'ref.png');
  const ref = await readFile(refPath);
  const form = new FormData();
  form.set('model', MODEL);
  form.set(
    'prompt',
    `Redraw this exact image: the same character, the same go-kart, the same pose, camera angle, colours, ` +
      `proportions and style, with one change. ${instruction} Change nothing else. ` +
      `Fully transparent background, no ground, no cast shadow, no text.`,
  );
  form.set('size', '1024x1024');
  form.set('quality', QUALITY);
  form.set('background', 'transparent');
  form.set('output_format', 'png');
  form.append('image[]', new Blob([ref], { type: 'image/png' }), 'ref.png');
  console.log(`[${id}] redrawing reference with ${MODEL}...`);
  const png = await openai('images/edits', form);
  await writeFile(path.join(RAW, id, 'ref.prev.png'), ref);
  await writeFile(refPath, png);
  console.log(`[${id}] wrote art/raw/${id}/ref.png (previous kept as ref.prev.png)`);
}

/** Size of a packed profile picture, in pixels. */
const AVATAR = 256;

/**
 * A profile picture of a racer: just the head, drawn from its reference so it
 * is the same character. Used where a small face reads better than a whole kart.
 */
async function makeAvatar(id) {
  const ref = await readFile(path.join(RAW, id, 'ref.png'));
  const form = new FormData();
  form.set('model', MODEL);
  form.set(
    'prompt',
    'A profile picture of EXACTLY the dinosaur character in the reference image: the same character, same ' +
      'colours, same features, same style. Show only its head and the top of its neck and shoulders, large ' +
      'and centred, facing the viewer and turned very slightly to one side, with a big friendly smile. ' +
      'No go-kart, no steering wheel, no seat, no hands. ' +
      'Pre-rendered CGI look: smooth rounded shapes, soft glossy shading like a vinyl toy, soft studio light ' +
      'from above, no outlines. Fully transparent background, no circle or frame, no ground, no shadow, no text.',
  );
  form.set('size', '1024x1024');
  form.set('quality', QUALITY);
  form.set('background', 'transparent');
  form.set('output_format', 'png');
  form.append('image[]', new Blob([ref], { type: 'image/png' }), 'ref.png');
  console.log(`[${id}] generating profile picture with ${MODEL}...`);
  const png = await openai('images/edits', form);
  await writeFile(path.join(RAW, id, 'avatar.png'), png);
  console.log(`[${id}] wrote art/raw/${id}/avatar.png`);
}

async function packAvatar(id) {
  const src = path.join(RAW, id, 'avatar.png');
  if (!(await exists(src))) return;
  await mkdir(OUT, { recursive: true });
  // Trim the empty border, then fit the face into a square with a little margin.
  const face = await sharp(src)
    .trim()
    .resize(AVATAR - 16, AVATAR - 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: { width: AVATAR, height: AVATAR, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: face }])
    .png()
    .toFile(path.join(OUT, `avatar-${id}.png`));
  console.log(`[${id}] packed public/sprites/avatar-${id}.png`);
}

/**
 * The game's logo, drawn with the racers' own reference art as input so that
 * it belongs to the same world. Written to public/logo.png.
 */
async function makeLogo() {
  const form = new FormData();
  form.set('model', MODEL);
  form.set(
    'prompt',
    'A logo for a cheerful children\'s go-kart racing video game called DINO KART. ' +
      'The words are big, chunky, rounded 3D letters with a thick dark-brown outline and a glossy toy-like ' +
      'finish, on two lines and leaning forwards as if speeding: "DINO" on the top line in bright leafy ' +
      'green with a row of small rounded dinosaur back-plates along the top edge of the letters, and "KART" ' +
      'on the bottom line, slightly larger, in sunny yellow-orange with a black-and-white chequered racing ' +
      'stripe running through the middle of the letters. The text reads exactly DINO KART and nothing else. ' +
      'The teal striped T-rex from the first reference image, in its red go-kart with the toothy jaw bumper, ' +
      'bursts out from behind the right-hand end of the logo, driving towards the viewer and grinning, with ' +
      'a few speed lines and a small puff of dust behind it. A chequered flag flutters at the top left corner. ' +
      'Match the reference images exactly for the character, kart and overall style: pre-rendered CGI look, ' +
      'smooth rounded shapes, soft glossy shading like vinyl toys, bright saturated colours, no thin outlines. ' +
      'An original logo design. Fully transparent background, no ground, no frame, no other text.',
  );
  form.set('size', '1536x1024');
  form.set('quality', QUALITY);
  form.set('background', 'transparent');
  form.set('output_format', 'png');
  for (const id of ['rex', 'trike', 'stego']) {
    const ref = await readFile(path.join(RAW, id, 'ref.png'));
    form.append('image[]', new Blob([ref], { type: 'image/png' }), `${id}.png`);
  }
  console.log(`[logo] generating with ${MODEL}...`);
  const png = await openai('images/edits', form);
  await mkdir(path.join(RAW, 'logo'), { recursive: true });
  await writeFile(path.join(RAW, 'logo', 'logo.png'), png);
  console.log('[logo] wrote art/raw/logo/logo.png');
}

async function packLogo() {
  // Trim the empty border and keep it big enough to stay sharp on a tablet.
  await sharp(path.join(RAW, 'logo', 'logo.png'))
    .trim()
    .resize({ width: 1200, withoutEnlargement: true })
    // Reduced to a palette: about an eighth of the file size, and it still looks clean at full size.
    .png({ palette: true, quality: 92 })
    .toFile(path.join(ROOT, 'public', 'logo.png'));
  console.log('[logo] packed public/logo.png');
}

/** Find the separate drawings on a transparent sheet. Returns bounding boxes. */
function findBlobs(data, width, height, minFrac = 0.25) {
  const ALPHA = 40;
  const label = new Int32Array(width * height).fill(-1);
  const blobs = [];
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (label[start] !== -1 || data[start * 4 + 3] <= ALPHA) continue;
    const id = blobs.length;
    const b = { x0: width, y0: height, x1: 0, y1: 0, area: 0, ids: [id] };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p - x) / width;
      b.area++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (label[n] === -1 && data[n * 4 + 3] > ALPHA) {
            label[n] = id;
            stack.push(n);
          }
        }
      }
    }
    blobs.push(b);
  }

  // Keep the real drawings; fold small detached bits (a floating spike, say)
  // into the nearest drawing, and drop specks.
  const biggest = Math.max(...blobs.map((b) => b.area));
  const main = blobs.filter((b) => b.area >= biggest * minFrac);
  const cx = (b) => (b.x0 + b.x1) / 2;
  const cy = (b) => (b.y0 + b.y1) / 2;
  for (const s of blobs) {
    if (main.includes(s) || s.area < 30) continue;
    let near = null;
    let best = Infinity;
    for (const m of main) {
      const d = Math.hypot(cx(s) - cx(m), cy(s) - cy(m));
      if (d < best) {
        best = d;
        near = m;
      }
    }
    if (near && best < Math.max(near.x1 - near.x0, near.y1 - near.y0) * 0.75) {
      near.x0 = Math.min(near.x0, s.x0);
      near.y0 = Math.min(near.y0, s.y0);
      near.x1 = Math.max(near.x1, s.x1);
      near.y1 = Math.max(near.y1, s.y1);
      near.ids.push(...s.ids);
    }
  }
  return { blobs: main, label };
}

/**
 * Cut one drawing out of the sheet as a PNG-ready sharp image. Only pixels that
 * belong to the drawing are kept, so a neighbour poking into its bounding box
 * doesn't come along.
 */
function cutBlob(data, width, label, b) {
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  const ids = new Set(b.ids);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (b.y0 + y) * width + (b.x0 + x);
      if (!ids.has(label[src])) continue;
      data.copy(out, (y * w + x) * 4, src * 4, src * 4 + 4);
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } });
}

async function pack(id) {
  const sheetPath = path.join(RAW, id, 'sheet.png');
  if (!(await exists(sheetPath))) {
    console.log(`[${id}] no sheet yet, skipping`);
    return false;
  }
  const img = sharp(sheetPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { blobs, label } = findBlobs(data, info.width, info.height);
  if (blobs.length !== ANGLES.length) {
    throw new Error(`[${id}] expected ${ANGLES.length} views on the sheet, found ${blobs.length}`);
  }

  // Reading order: split into rows by vertical centre, then left to right.
  blobs.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const ordered = [];
  for (let r = 0; r < blobs.length; r += COLS) {
    ordered.push(...blobs.slice(r, r + COLS).sort((a, b) => a.x0 - b.x0));
  }
  const widthOf = (b) => b.x1 - b.x0 + 1;
  const heightOf = (b) => b.y1 - b.y0 + 1;

  // One scale for every frame so the racer doesn't change size as it turns,
  // chosen so that every racer's KART is the same size: we measure the kart by
  // its width from behind and its length from the side, which a tall neck or a
  // big frill doesn't change.
  const rearW = widthOf(ordered[ANGLES.indexOf(0)]);
  const sideW = (widthOf(ordered[ANGLES.indexOf(90)]) + widthOf(ordered[ANGLES.indexOf(-90)])) / 2;
  let scale = KART_PX / Math.sqrt(rearW * sideW);
  // If something still doesn't fit its cell, shrink the whole racer to fit and say so.
  const fit = Math.min(
    (CELL_W - CELL_PAD * 2) / (Math.max(...ordered.map(widthOf)) * scale),
    (CELL_H - CELL_PAD * 2) / (Math.max(...ordered.map(heightOf)) * scale),
  );
  if (fit < 1) {
    console.warn(`[${id}] too big for its cell: drawn at ${Math.round(fit * 100)}% of the standard kart size`);
    scale *= fit;
  }

  const rows = Math.ceil(ordered.length / ATLAS_COLS);
  const layers = [];
  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i];
    const sw = Math.max(1, Math.round(widthOf(b) * scale));
    const sh = Math.max(1, Math.round(heightOf(b) * scale));
    const frame = await cutBlob(data, info.width, label, b)
      .resize(sw, sh, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
    // Bottom-centre aligned: the tyres always sit on the same baseline.
    layers.push({
      input: frame,
      left: (i % ATLAS_COLS) * CELL_W + Math.round((CELL_W - sw) / 2),
      top: Math.floor(i / ATLAS_COLS) * CELL_H + CELL_H - CELL_PAD - sh,
    });
  }

  await mkdir(OUT, { recursive: true });
  await sharp({
    create: {
      width: CELL_W * ATLAS_COLS,
      height: CELL_H * rows,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .png()
    .toFile(path.join(OUT, `${id}.png`));
  await writeFile(
    path.join(OUT, `${id}.json`),
    JSON.stringify(
      {
        id,
        name: RACERS[id].name,
        cellW: CELL_W,
        cellH: CELL_H,
        cols: ATLAS_COLS,
        rows,
        pad: CELL_PAD,
        // How many pixels the standard kart size comes out as on this sheet.
        kartPx: Math.round(KART_PX * Math.min(1, fit)),
        angles: ANGLES,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`[${id}] packed public/sprites/${id}.png`);
  return true;
}

/**
 * Object sheets: rows of separate objects, each packed to fill its own square
 * cell. Used for trackside scenery and for items. A sheet is made of one or
 * more parts, each generated as its own image (art/raw/<part>/sheet.png), so
 * objects can be added later without regenerating the ones already approved.
 */
const OBJECT_STYLE = [
  'Style: sprites from a mid-1990s 3D kart racing video game, pre-rendered CGI look: smooth rounded',
  'shapes, soft glossy shading like vinyl toys, bright saturated colours, soft studio light from above,',
  'no outlines. Fully transparent background.',
  'No ground, no cast shadow, no text, no border, no characters.',
].join(' ');
const SIDE_VIEW = 'Each is seen from the side at eye level.';

const OBJECT_SHEETS = {
  scenery: [
    {
      raw: 'scenery',
      names: ['palm', 'fern', 'cycad'],
      view: SIDE_VIEW,
      objects: [
        'on the left, a tall tropical palm tree with a curved trunk and a round crown of big leaves',
        'in the middle, a low, wide, leafy green fern bush',
        'on the right, a chunky prehistoric cycad tree with a short fat scaly trunk and a crown of long fronds',
      ],
    },
  ],
  props: [
    {
      raw: 'props',
      names: ['volcano', 'skull', 'nest'],
      view: SIDE_VIEW,
      objects: [
        'on the left, a chunky cartoon volcano: a wide brown-grey rocky cone with a glowing orange lava crater at the top, bright lava dribbling down its sides and a small puff of white smoke above it',
        'in the middle, a giant fossil T-rex skull, cream-white bone with big rounded teeth and a friendly look, half-sunk in the ground, facing left',
        'on the right, a round nest of twigs and leaves holding three big cream dinosaur eggs with pale blue spots',
      ],
    },
    {
      raw: 'props2',
      names: ['brachio', 'trike', 'boulder', 'bush'],
      view: SIDE_VIEW,
      objects: [
        'first, a huge friendly purple cartoon brachiosaurus standing on four legs with its long neck up, smiling, watching a race',
        'second, a chubby friendly orange cartoon triceratops standing on four legs, smiling, watching a race',
        'third, a big rounded grey boulder with a little moss on top',
        'fourth, a round leafy green bush covered in big pink and yellow tropical flowers',
      ],
    },
    {
      raw: 'props3',
      names: ['banner', 'torch', 'sign'],
      view: 'Each is seen straight on from the front at eye level.',
      objects: [
        'on the left, a wide start-line gate for a go-kart race: two tall wooden posts joined across the top by a string of colourful triangular bunting flags and a black-and-white chequered banner, with nothing between the posts underneath so karts can drive through',
        'in the middle, a tall wooden tiki torch with a bright cartoon flame on top',
        'on the right, a wooden signpost with a big yellow arrow-shaped board pointing to the right, with no writing on it',
      ],
    },
  ],
  // Glacier Glide: snowy scenery, things to dodge, and the ice-age landmarks.
  snow: [
    {
      raw: 'snow1',
      names: ['pine', 'snowBoulder', 'crystals', 'iceRock'],
      view: SIDE_VIEW,
      objects: [
        'first, a chunky cartoon pine tree with thick layers of white snow on its dark green branches',
        'second, a big rounded grey boulder with a thick cap of white snow on top',
        'third, a cluster of tall pale-blue ice crystals growing out of a small mound of snow',
        'fourth, a jagged lump of bright blue glacier ice, like a small iceberg, with frosty white edges',
      ],
    },
    {
      raw: 'snow2',
      names: ['trexIce', 'trikeStatue', 'pteroFossil', 'sauropod'],
      view: SIDE_VIEW,
      objects: [
        'first, a huge block of clear pale-blue glacier ice with a complete cream-white T-rex skeleton frozen inside it, the skull with big rounded teeth clearly visible, snow on top of the block',
        'second, a big friendly statue of a triceratops carved out of pale grey-blue ice, standing on a snowy rock base, with cream-white horns and a dusting of snow on its frill and back',
        'third, a large upright slab of grey rock with a snowy top, and the cream-white fossil skeleton of a pterodactyl with its wings spread wide embedded in the face of the slab',
        'fourth, a huge friendly purple cartoon brachiosaurus standing on four legs with its long neck up, smiling, wearing a little red woolly scarf, with snow on its back',
      ],
    },
    {
      raw: 'snow3',
      names: ['skullArch', 'snowNest'],
      view: 'Each is seen straight on from the front at eye level.',
      objects: [
        'on the left, an archway made from a gigantic cream-white fossil T-rex skull with its jaws wide open, seen from the front: the upper jaw with big rounded teeth forms the top of the arch, two thick pillars of blue glacier ice hold it up at the sides, snow lies on top, and the wide opening underneath is completely empty so that go-karts can drive through it',
        'on the right, a round nest made of icy twigs and snow holding three big pastel-purple dinosaur eggs with pale blue spots',
      ],
    },
  ],
  items: [
    {
      raw: 'items',
      names: ['box', 'bone', 'drumstick', 'egg'],
      view: SIDE_VIEW,
      objects: [
        'first, a big upright dinosaur egg, cream white with large round spots in rainbow colours (red, orange, yellow, green, blue, purple)',
        'second, a chunky white cartoon dog-bone with rounded knobbly ends, lying at a slight angle',
        'third, a big juicy roasted meat drumstick, golden brown, on a short white bone',
        'fourth, a plain upright dinosaur egg, bright green with a few darker green spots',
      ],
    },
    {
      raw: 'items2',
      names: ['ptero', 'tar'],
      view: '',
      objects: [
        'on the left, a big friendly purple cartoon pterodactyl in flight, seen from behind and slightly above so we look along its back: wings spread wide to both sides, long head crest, feet dangling ready to carry something',
        'on the right, a round puddle of glossy black tar with a few shiny bubbles and a thick rounded rim, seen from above at a three-quarter angle',
      ],
    },
  ],
};
const OBJECT_CELL = 256;

async function makeObjects(part) {
  const { objects } = part;
  const prompt = [
    `${objects.length} separate objects side by side in one row, evenly spaced, all about the same size,`,
    'with clear empty space between them so that none of them touch, each fully visible:',
    objects.map((o, i) => `${i + 1}) ${o}`).join('; ') + '.',
    part.view,
    OBJECT_STYLE,
  ].join(' ');
  console.log(`[${part.raw}] generating with ${MODEL}...`);
  const png = await openai('images/generations', {
    model: MODEL,
    prompt,
    size: '1536x1024',
    quality: QUALITY,
    background: 'transparent',
    output_format: 'png',
  });
  await mkdir(path.join(RAW, part.raw), { recursive: true });
  await writeFile(path.join(RAW, part.raw, 'sheet.png'), png);
  console.log(`[${part.raw}] wrote art/raw/${part.raw}/sheet.png`);
}

async function packObjects(sheet) {
  const cut = [];
  for (const part of OBJECT_SHEETS[sheet]) {
    const sheetPath = path.join(RAW, part.raw, 'sheet.png');
    const { data, info } = await sharp(sheetPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const found = findBlobs(data, info.width, info.height, 0.05);
    const blobs = found.blobs.sort((a, b) => a.x0 - b.x0);
    if (blobs.length !== part.names.length) {
      throw new Error(`[${part.raw}] expected ${part.names.length} objects on the sheet, found ${blobs.length}`);
    }
    blobs.forEach((b, i) => cut.push({ name: part.names[i], b, data, width: info.width, label: found.label }));
  }

  const layers = [];
  const frames = [];
  for (let i = 0; i < cut.length; i++) {
    const { name, b, data, width, label } = cut[i];
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    const scale = (OBJECT_CELL - CELL_PAD * 2) / Math.max(w, h);
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    const frame = await cutBlob(data, width, label, b)
      .resize(sw, sh, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
    layers.push({
      input: frame,
      left: i * OBJECT_CELL + Math.round((OBJECT_CELL - sw) / 2),
      top: OBJECT_CELL - CELL_PAD - sh,
    });
    frames.push({ name, width: sw, height: sh });
  }
  await mkdir(OUT, { recursive: true });
  await sharp({
    create: {
      width: OBJECT_CELL * cut.length,
      height: OBJECT_CELL,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .png()
    .toFile(path.join(OUT, `${sheet}.png`));
  await writeFile(
    path.join(OUT, `${sheet}.json`),
    JSON.stringify({ cell: OBJECT_CELL, pad: CELL_PAD, frames }, null, 2) + '\n',
  );
  console.log(`[${sheet}] packed public/sprites/${sheet}.png`);
}

const [cmd, ...ids] = process.argv.slice(2);
if (cmd === 'logo') {
  // `logo new` draws a fresh one; otherwise the existing drawing is just re-packed.
  if (ids[0] === 'new' || !(await exists(path.join(RAW, 'logo', 'logo.png')))) await makeLogo();
  await packLogo();
  process.exit(0);
}
if (cmd === 'tweak') {
  const [id, ...words] = ids;
  if (!RACERS[id] || !words.length) throw new Error('usage: npm run sprites -- tweak <racer id> "<what to change>"');
  await tweakRef(id, words.join(' '));
  process.exit(0);
}
const targets = ids.length ? ids : Object.keys(RACERS);
if (!OBJECT_SHEETS[cmd]) {
  for (const id of targets) if (!RACERS[id]) throw new Error(`unknown racer "${id}"`);
}

if (OBJECT_SHEETS[cmd]) {
  // "new <part>" throws away that part's image and generates a fresh one,
  // e.g. `npm run sprites -- items new items2`.
  for (const part of OBJECT_SHEETS[cmd]) {
    const redo = ids[0] === 'new' && ids[1] === part.raw;
    if (redo || !(await exists(path.join(RAW, part.raw, 'sheet.png')))) await makeObjects(part);
  }
  await packObjects(cmd);
} else if (cmd === 'ref') for (const id of targets) await makeRef(id);
else if (cmd === 'sheet') for (const id of targets) await makeSheet(id);
else if (cmd === 'avatar') {
  // Racers that already have a profile picture are only re-packed; delete the raw file to redo one.
  await Promise.all(
    targets.map(async (id) => {
      if (!(await exists(path.join(RAW, id, 'avatar.png')))) await makeAvatar(id);
      await packAvatar(id);
    }),
  );
} else if (cmd === 'pack') for (const id of targets) await pack(id);
else if (cmd === 'all') {
  for (const id of targets) {
    if (!(await exists(path.join(RAW, id, 'ref.png')))) await makeRef(id);
    if (!(await exists(path.join(RAW, id, 'sheet.png')))) await makeSheet(id);
    await pack(id);
  }
} else {
  console.log('usage: npm run sprites -- <ref|sheet|avatar|pack|all|scenery|props|snow|items> [racer ids...]');
  process.exit(1);
}
