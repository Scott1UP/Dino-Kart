// Takes pictures and film of the game itself, for the track select cards and the title screen.
//
//   npm run capture             both: the cover pictures, then the title film
//   npm run capture -- covers   public/covers/<track id>.jpg, one per track
//   npm run capture -- film     public/title.mp4, about 30 seconds cut from both tracks
//   npm run capture -- stills   candidate cover pictures only, into the folder given by --out
//
// It runs the game in a headless browser in its capture mode (`?capture`), where a race is
// driven one frame at a time, so the film is perfectly smooth however slowly the browser draws.
// Needs ffmpeg on the PATH for the film, and Playwright's cached headless Chromium.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const what = args.find((a) => !a.startsWith('--')) ?? 'all';
const outFlag = args.indexOf('--out');
const stillsDir = outFlag >= 0 ? args[outFlag + 1] : null;

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

// The cover picture of each track: the scenery alone, with the camera standing at `from`
// and looking at `to` (each is x, height, z in the track's own units).
const COVERS = {
  'dino-falls': { from: [1292, 16, 1010], to: [1282, 30, 770] },
  'glacier-glide': { from: [1925, 62, 790], to: [1885, 90, 560] },
};
// Other views to look at when choosing a cover (`npm run capture -- stills --out <folder>`).
const CANDIDATES = {
  'dino-falls': [
    { from: [1292, 16, 1010], to: [1282, 30, 770] }, // up the river to the waterfall
    { from: [760, 30, 1150], to: [540, 80, 640] }, // across the start straight to the volcano
    { from: [1330, 14, 1098], to: [1080, 26, 1100] }, // along the river to the bridge
    { from: [330, 34, 1120], to: [540, 90, 640] }, // the volcano from the first corner
    { from: [900, 60, 1010], to: [540, 70, 640] }, // high over the middle
    { from: [1292, 30, 1120], to: [1284, 28, 760] }, // the falls from further back
  ],
  'glacier-glide': [
    { from: [1925, 62, 790], to: [1885, 90, 560] }, // up the ice crest to the skull arch
    { from: [1250, 20, 1335], to: [1250, 60, 1085] }, // the frozen T-rex from the start straight
    { from: [330, 26, 900], to: [520, 50, 640] }, // across the frozen lake to the triceratops
    { from: [1060, 60, 430], to: [1020, 40, 105] }, // the ridge and the pterodactyl fossil
    { from: [1000, 24, 1300], to: [1250, 70, 1085] }, // the frozen T-rex, closer
    { from: [1915, 58, 700], to: [1880, 95, 560] }, // the skull arch, closer
  ],
};
// The title film: four shots, cut together. Each starts with the kart at `waypoint`.
const FILM = [
  { track: 'dino-falls', racer: 'rex', waypoint: 30.4, seconds: 7.5 }, // down the waterfall
  { track: 'glacier-glide', racer: 'trike', waypoint: 5.4, seconds: 7.5 }, // ice crest and skull arch
  { track: 'dino-falls', racer: 'raptor', waypoint: 15.6, seconds: 7.5 }, // over the bridge
  { track: 'glacier-glide', racer: 'ptero', waypoint: 15.6, seconds: 7.5 }, // cliff jump onto the lake
];

function findBrowser() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const shells = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')) : [];
  for (const dir of shells.sort().reverse()) {
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-mac']) {
      const exe = join(cache, dir, arch, 'chrome-headless-shell');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error(`No headless Chromium found in ${cache}. Run "npx playwright install chromium-headless-shell".`);
}

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: false } });
await server.listen();
const url = `${server.resolvedUrls.local[0]}?capture`;
const browser = await chromium.launch({
  executablePath: findBrowser(),
  // Draw with the software renderer so 3D works without a screen or a graphics card.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.goto(url);
  await page.waitForFunction(() => '__capture' in window, null, { timeout: 120000 });
  const canvas = page.locator('#game');

  /** A picture of a track's scenery from a fixed viewpoint, as a JPEG. */
  async function still({ track, from, to }) {
    await page.evaluate(([t, f, o]) => window.__capture.view(t, f, o), [track, from, to]);
    return canvas.screenshot({ type: 'jpeg', quality: 95 });
  }

  if (what === 'stills') {
    if (!stillsDir) throw new Error('stills needs --out <folder>');
    mkdirSync(stillsDir, { recursive: true });
    for (const [track, shots] of Object.entries(CANDIDATES)) {
      for (const [n, shot] of shots.entries()) {
        const file = join(stillsDir, `${track}-${n + 1}.jpg`);
        await sharp(await still({ track, ...shot })).resize(960).jpeg({ quality: 85 }).toFile(file);
        console.log(`wrote ${file}`);
      }
    }
  }

  if (what === 'covers' || what === 'all') {
    mkdirSync(join(root, 'public/covers'), { recursive: true });
    for (const [track, shot] of Object.entries(COVERS)) {
      // The cards are 8:5; crop the 16:9 frame to that around its middle.
      await sharp(await still({ track, ...shot }))
        .resize(640, 400, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 84, mozjpeg: true })
        .toFile(join(root, 'public/covers', `${track}.jpg`));
      console.log(`wrote public/covers/${track}.jpg`);
    }
  }

  if (what === 'film' || what === 'all') {
    const frames = mkdtempSync(join(tmpdir(), 'dino-kart-film-'));
    let count = 0;
    for (const [n, shot] of FILM.entries()) {
      console.log(`shot ${n + 1}/${FILM.length}: ${shot.track} behind ${shot.racer}`);
      await page.evaluate(([t, r, w]) => window.__capture.shot(t, r, w), [shot.track, shot.racer, shot.waypoint]);
      for (let f = 0; f < Math.round(shot.seconds * FPS); f++) {
        await page.evaluate((dt) => window.__capture.frame(dt), 1 / FPS);
        await canvas.screenshot({
          type: 'jpeg',
          quality: 92,
          path: join(frames, `${String(count++).padStart(5, '0')}.jpg`),
        });
      }
    }
    // H.264 in an MP4 plays everywhere, including iPads. No sound: the menu music plays over it.
    execFileSync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'),
        '-vf', 'scale=960:540:flags=lanczos',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-an',
        join(root, 'public/title.mp4'),
      ],
      { stdio: 'inherit' },
    );
    rmSync(frames, { recursive: true, force: true });
    console.log(`wrote public/title.mp4 (${count} frames, ${(count / FPS).toFixed(1)}s)`);
  }
} finally {
  await browser.close();
  await server.close();
}
