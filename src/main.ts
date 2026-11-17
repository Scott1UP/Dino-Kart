import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import './style.css';
import * as THREE from 'three';
import { sound } from './audio';
import { Input } from './input';
import { ItemSystem, type ItemEvent } from './items';
import { Kart, separate } from './kart';
import { LAYOUTS, THEMES, type Layout, type SurfaceLoopId } from './layouts';
import { makeRng } from './rng';
import { makeSky } from './sky';
import { loadKit, loadRacer, type SpriteKit } from './sprites';
import { Track, WALL_DIST } from './track';
import { ui } from './ui';
import { voice, type VoiceLine } from './voice';

// ---- Tuning -----------------------------------------------------------------
/**
 * "Retro look": the short side of the screen is rendered at this many pixels
 * and upscaled, for the soft, chunky picture of a mid-90s console. When it is
 * off the game renders at the screen's own resolution.
 */
const RETRO_RES = 300;
const RETRO_KEY = 'dino-kart-retro';
/** Sharpest we render with the retro look off; more than this costs speed for little gain. */
const MAX_PIXEL_RATIO = 2;

const RACER_IDS = ['rex', 'trike', 'stego', 'raptor', 'brachio', 'ptero'];
/**
 * Speed classes. 125cc is the base game; the others multiply every kart's top
 * speed. The track's tightest bend can still be driven at 200cc without
 * leaving the road.
 */
const SPEED_CLASSES: Record<number, number> = { 125: 1, 150: 1.12, 200: 1.3 };
const SPEED_CLASS_KEY = 'dino-kart-class';
const PLAYER_SPEED = 138;
/** Computer drivers are a little slower than the player on a clear road... */
const RIVAL_SPEEDS = [128, 125, 122, 119, 116];
/**
 * ...and speed up when behind the player or ease off when ahead, so the pack
 * stays together. The gap is measured in centre-line samples.
 */
const RUBBER_BAND_GAP = 100;
const RUBBER_BAND_MIN = 0.78;
const RUBBER_BAND_MAX = 1.2;
const COUNTDOWN_SECONDS = 3;
/** Speed of the karts circling behind the menus. */
const DEMO_SPEED = 115;
/** Lanes the karts hold when a computer is driving. */
const LANES = [0, 22, -22, 11, -11, 30];
/** Starting grid: two columns this far either side of the centre line, rows this many samples apart. */
const GRID_LANE = 16;
const GRID_ROW_GAP = 4;

const CAM_BACK = 36;
const CAM_HEIGHT = 14;
const CAM_LOOK_AHEAD = 30;
const CAM_FOV = 58;
/** The view widens by this many degrees during a speed boost. */
const CAM_BOOST_FOV = 9;
/**
 * On an upright phone the view is so narrow that the kart would fill it, so the camera pulls
 * back, climbs and widens its lens to show more of the road ahead. These are the amounts at
 * the full effect, for a screen NARROW_FULL wide for its height or narrower; the effect eases
 * in from nothing at NARROW_START (a little narrower than square).
 */
const NARROW_START = 0.9;
const NARROW_FULL = 0.5;
const NARROW_CAM_BACK = 20;
const NARROW_CAM_HEIGHT = 12;
const NARROW_CAM_FOV = 8;
/** Behind the menus the camera sits further back and higher. */
const DEMO_CAM_BACK = 62;
const DEMO_CAM_HEIGHT = 30;
/** World size of the standard kart that every racer's sprite is scaled to. */
const KART_SIZE = 13.5;
/**
 * Another kart right behind the player would fill the screen, so karts fade
 * out as they near the camera: solid at FADE_FAR units in front of the lens,
 * gone by FADE_NEAR. (The player's own kart sits CAM_BACK in front of it.)
 */
const FADE_FAR = 30;
const FADE_NEAR = 14;
/** How far the kart sprite visibly turns into a corner, in degrees. */
const STEER_VIEW_ANGLE = 22;
/** The view of each racer shown on its character select card (front three-quarter). */
const PORTRAIT_ANGLE = 157;

const TRACK_KEY = 'dino-kart-track';
/** The camera never dips closer to the ground than this (it would end up inside a cliff). */
const CAM_CLEARANCE = 7;

// ---- Renderer -----------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement;
/**
 * Capture mode (`?capture` in the address): no menus and no clock of its own.
 * `scripts/capture.mjs` drives it one frame at a time to take the track cover
 * pictures and the title-screen video.
 */
const CAPTURE = new URLSearchParams(location.search).has('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: CAPTURE });
renderer.setPixelRatio(1);

function readRetro(): boolean {
  try {
    return localStorage.getItem(RETRO_KEY) === 'on';
  } catch {
    return false;
  }
}
let retro = readRetro();

function readSpeedClass(): number {
  try {
    const saved = Number(localStorage.getItem(SPEED_CLASS_KEY));
    return saved in SPEED_CLASSES ? saved : 125;
  } catch {
    return 125;
  }
}
let speedClass = readSpeedClass();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 1, 6000);
/** How upright the screen is: 0 on wide screens, rising to 1 on an upright phone (see NARROW_START). */
let narrow = 0;

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  narrow = Math.min(1, Math.max(0, (NARROW_START - w / h) / (NARROW_START - NARROW_FULL)));
  const scale = retro ? RETRO_RES / Math.min(w, h) : Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setSize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- Racers ------------------------------------------------------------------
const [racerSprites, itemKit] = await Promise.all([
  Promise.all(RACER_IDS.map((id) => loadRacer(id, KART_SIZE))),
  loadKit('items'),
]);

const karts = racerSprites.map((sprite, i) => new Kart(RACER_IDS[i], sprite));
/** The kart the human drives (and the camera follows). */
let player = karts[0];
let rivals = karts.slice(1);

const shadowGeometry = new THREE.CircleGeometry(KART_SIZE * 0.5, 16);
const shadowMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
});
const shadows = karts.map((kart) => {
  scene.add(kart.sprite.sprite);
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);
  return shadow;
});

const input = new Input(canvas);

/**
 * The film behind the menus (made by `npm run capture`). While it is playing
 * the game itself is neither simulated nor drawn; if it cannot be played, the
 * karts circle the track behind the menus instead.
 */
const menuVideo = document.getElementById('menu-video') as HTMLVideoElement;
let menuVideoPlaying = false;
menuVideo.addEventListener('playing', () => (menuVideoPlaying = true));
menuVideo.addEventListener('pause', () => (menuVideoPlaying = false));
menuVideo.addEventListener('error', () => (menuVideoPlaying = false));
function showMenuVideo(show: boolean): void {
  menuVideo.classList.toggle('hidden', !show);
  if (show) void menuVideo.play().catch(() => (menuVideoPlaying = false));
  else menuVideo.pause();
}

// ---- World: the track and everything on it, rebuilt when a different track is chosen ----
let track!: Track;
let items!: ItemSystem;
let water!: ReturnType<Track['makeWater']>;
let sky!: ReturnType<typeof makeSky>;
/** Holds every object that belongs to the current track, so it can all be removed together. */
let world = new THREE.Group();

/** Sprite sheets, loaded once and kept: tracks with the same theme share them. */
const kits = new Map<string, SpriteKit>();
async function getKit(name: string): Promise<SpriteKit> {
  let kit = kits.get(name);
  if (!kit) {
    kit = await loadKit(name);
    kits.set(name, kit);
  }
  return kit;
}
const kit = (name: string): SpriteKit => {
  const found = kits.get(name);
  if (!found) throw new Error(`sprite sheet "${name}" is not loaded (add it to the theme's kits)`);
  return found;
};

/** Stand a scenery sprite on the ground at a point. */
function place(sprite: THREE.Sprite, x: number, z: number, y = track.heightAt(x, z)): void {
  sprite.position.set(x, y, z);
  world.add(sprite);
}

/**
 * Scatter something along both sides of the track, between `near` and `far`
 * units beyond the soft wall. `make` is given a random-number source and
 * returns the sprite to plant.
 */
function scatter(
  count: number,
  near: number,
  far: number,
  seed: number,
  make: (rand: () => number) => THREE.Sprite,
): void {
  const rand = makeRng(seed);
  let planted = 0;
  for (let tries = 0; planted < count && tries < count * 25; tries++) {
    const i = Math.floor(rand() * track.count);
    const side = rand() < 0.5 ? -1 : 1;
    const offset = WALL_DIST + near + rand() * rand() * (far - near); // denser close to the track
    const [x, z] = track.beside(i, offset * side);
    // The point can land near a different stretch of road, especially inside bends.
    if (track.query(x, z).dist < WALL_DIST + near - 2) continue;
    place(make(rand), x, z);
    planted++;
  }
}

function buildScenery(layout: Layout): void {
  const { scenery } = layout;
  for (const spec of scenery.scatter) {
    scatter(spec.count, spec.near, spec.far, spec.seed, (rand) =>
      kit(spec.sheet).make(spec.sprite, spec.min + rand() * (spec.max - spec.min), rand() < 0.5),
    );
  }
  for (const mark of scenery.landmarks) {
    place(kit(mark.sheet).make(mark.sprite, mark.height, mark.mirror), mark.x, mark.y);
  }
  // Rocks on the road, drawn a little bigger than the circle that karts bump into.
  for (const rock of track.rocks) {
    place(kit(rock.sheet).make(rock.sprite, rock.radius * 2.1), rock.x, rock.z, rock.y);
  }
  // Things that stand over the road to be driven through.
  for (const arch of scenery.arches) {
    const sample = track.sampleAt(arch.waypoint);
    const sheet = kit(arch.sheet);
    place(
      sheet.make(arch.sprite, arch.width / sheet.aspect(arch.sprite)),
      track.xs[sample],
      track.zs[sample],
      track.roadY(sample),
    );
  }

  // Start line: a banner over the road with torches along the straight.
  const props = kit('props');
  const bannerWidth = track.roadHalf * 2 + 34;
  place(props.make('banner', bannerWidth / props.aspect('banner')), track.xs[0], track.zs[0]);
  for (let n = 0; n < 4; n++) {
    const sample = track.count - 6 + n * 24;
    for (const side of [-1, 1]) {
      place(props.make('torch', 24), ...track.beside(sample, side * (track.roadHalf + 12)));
    }
  }

  // Arrow signs on the outside of the corners, pointing the way the road turns.
  for (const waypoint of scenery.signs) {
    const sample = track.sampleAt(waypoint);
    const turn = track.headingAt(sample + 14) - track.headingAt(sample - 14);
    const right = Math.atan2(Math.sin(turn), Math.cos(turn)) > 0;
    // The sign's arrow points right as drawn; mirrored for a left-hand corner.
    place(props.make('sign', 22, !right), ...track.beside(sample, (right ? -1 : 1) * (WALL_DIST + 12)));
  }
}

function readTrackId(): string {
  try {
    return localStorage.getItem(TRACK_KEY) ?? LAYOUTS[0].id;
  } catch {
    return LAYOUTS[0].id;
  }
}

/** Build a track and everything on it, replacing whichever one was there before. */
async function loadTrack(id: string): Promise<void> {
  const layout = LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
  if (track?.layout === layout) return;
  const theme = THEMES[layout.theme];
  await Promise.all(theme.kits.map(getKit));

  // Clear away the old track. Sprites share their materials with the sheets
  // they came from, which are kept; everything else was made for that track.
  scene.remove(world);
  world.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const material = object.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
  });
  world = new THREE.Group();
  scene.add(world);

  track = new Track(layout, theme);
  track.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  water = track.makeWater();
  sky = makeSky(theme.sky);
  // Plain ground out to the horizon, beyond the edge of the terrain.
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(12000, 12000),
    new THREE.MeshBasicMaterial({ color: theme.plain }),
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(track.centre.x, -0.5, track.centre.z);
  world.add(track.makeGround(), track.makeFences(), track.makeBridges(), water.object, outer, sky.mesh);
  scene.background = new THREE.Color(theme.sky.top);
  scene.fog = new THREE.Fog(theme.sky.haze, 320, 1700);
  buildScenery(layout);

  items = new ItemSystem(world, track, itemKit, karts, onItemEvent);
  try {
    localStorage.setItem(TRACK_KEY, layout.id);
  } catch {
    // Storage unavailable (private window): the choice just won't be remembered.
  }
}

// ---- Game state ---------------------------------------------------------------
/** 'demo' = karts circling by themselves behind the title and character select screens. */
let mode: 'demo' | 'race' = 'demo';
let paused = false;
type Phase = 'countdown' | 'racing' | 'finished';
let phase: Phase = 'countdown';
let countdown = COUNTDOWN_SECONDS;
let countdownShown = 0; // last number beeped
let goTimer = 0; // how much longer "GO!" stays on screen
let finishers = 0;
let lapShown = 1;

function onItemEvent(event: ItemEvent, kart: Kart): void {
  if (mode !== 'race' || kart !== player) return;
  if (event === 'pickup') sound.pickup();
  else if (event === 'got') sound.gotItem();
  else if (event === 'bone') sound.drop();
  else if (event === 'boost') sound.boost();
  else if (event === 'egg') sound.throwEgg();
  else if (event === 'tar') sound.tar();
  else if (event === 'stuck') sound.stuck();
  else if (event === 'ptero') sound.ptero();
  else sound.hit();
}
await loadTrack(readTrackId());

/** Line the karts up two by two just behind the start line, in the order given (first = front). */
function lineUp(order: Kart[]): void {
  order.forEach((kart, i) => {
    const row = Math.floor(i / 2);
    kart.placeOnGrid(track, track.count - 5 - row * GRID_ROW_GAP, i % 2 === 0 ? -GRID_LANE : GRID_LANE);
  });
  items.reset();
}

/** Everyone drives themselves round the track; used behind the menus. */
function startDemo(): void {
  mode = 'demo';
  paused = false;
  karts.forEach((kart, i) => {
    kart.topSpeed = DEMO_SPEED;
    kart.lane = LANES[i];
  });
  items.player = null;
  lineUp(karts);
  sound.playMusic('theme');
  showMenuVideo(true);
}

function startRace(playerId: string): void {
  player = karts.find((kart) => kart.id === playerId) ?? karts[0];
  rivals = karts.filter((kart) => kart !== player);
  const faster = SPEED_CLASSES[speedClass];
  player.topSpeed = PLAYER_SPEED * faster;
  player.lane = LANES[0];
  rivals.forEach((rival, i) => {
    rival.topSpeed = RIVAL_SPEEDS[i] * faster;
    rival.lane = LANES[i + 1];
  });
  items.player = player;
  // Rivals in front, the player at the back of the grid.
  lineUp([...rivals, player]);

  mode = 'race';
  paused = false;
  phase = 'countdown';
  countdown = COUNTDOWN_SECONDS;
  countdownShown = 0;
  goTimer = 0;
  finishers = 0;
  lapShown = 1;
  ui.show('race');
  sound.playMusic(track.layout.id);
  showMenuVideo(false);
}

function pause(): void {
  if (mode !== 'race' || phase === 'finished' || paused) return;
  paused = true;
  ui.show('pause');
  sound.suspend();
}

// ---- Menus --------------------------------------------------------------------
ui.setRacers(
  karts.map((kart) => ({
    id: kart.id,
    name: kart.sprite.meta.name,
    cols: kart.sprite.meta.cols,
    rows: kart.sprite.meta.rows,
    portraitFrame: kart.sprite.frameFor(PORTRAIT_ANGLE),
  })),
  // First tap: the racer introduces itself. Second tap, or Go: start the race.
  (id) => {
    sound.unlock();
    sound.tap();
    voice.say(`pick.${id}` as VoiceLine);
  },
  (id) => {
    sound.unlock();
    sound.tap();
    voice.stop();
    chosenRacer = id;
    ui.show('tracks');
  },
);
/** The racer picked on the character select screen, waiting for a track to be chosen. */
let chosenRacer = karts[0].id;
ui.setTracks(
  LAYOUTS.map((layout) => ({ id: layout.id, name: layout.name })),
  // First tap: the track is announced. Second tap, or Go: start the race.
  (id) => {
    sound.unlock();
    sound.tap();
    voice.say(`track.${id}` as VoiceLine);
  },
  (id) => {
    sound.unlock();
    sound.tap();
    voice.stop();
    // Building a track takes a moment; start the race as soon as it is ready.
    void loadTrack(id).then(() => startRace(chosenRacer));
  },
);
// Back from the track select to choose a different dino.
ui.on('tracks-back', () => {
  sound.tap();
  voice.stop();
  ui.show('select');
});
ui.setSound(sound.enabled);
ui.setMusic(sound.musicOn);
ui.setRetro(retro);
ui.setSpeedClass(speedClass);
ui.onSpeedClass((cc) => {
  speedClass = cc;
  try {
    localStorage.setItem(SPEED_CLASS_KEY, String(cc));
  } catch {
    // Storage unavailable (private window): the choice just won't be remembered.
  }
  ui.setSpeedClass(cc);
  sound.unlock();
  sound.tap();
});

/** Use the held item: the big button on screen, or the space bar. */
function fire(): void {
  if (mode === 'race' && phase === 'racing' && !paused) items.firePlayer();
}
ui.onFire(fire);
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  e.preventDefault();
  fire();
});

ui.on('play', () => {
  sound.unlock();
  sound.tap();
  ui.show('select');
});
ui.on('pause', pause);
function resume(): void {
  paused = false;
  sound.resume();
  ui.show('race');
}
ui.on('resume', resume);
ui.on('again', () => {
  voice.stop();
  startRace(player.id);
});
ui.on('change', () => {
  voice.stop();
  sound.resume();
  startDemo();
  ui.show('select');
});
ui.on('sound', () => {
  sound.setEnabled(!sound.enabled);
  ui.setSound(sound.enabled);
});
ui.on('music', () => {
  sound.setMusic(!sound.musicOn);
  ui.setMusic(sound.musicOn);
});
ui.on('retro', () => {
  retro = !retro;
  try {
    localStorage.setItem(RETRO_KEY, retro ? 'on' : 'off');
  } catch {
    // Storage unavailable (private window): the setting just won't be remembered.
  }
  ui.setRetro(retro);
  resize();
});
// Settings open on top of the pause menu and go back to it. The game stays
// paused, but sound is let through so the toggles can be heard.
let inSettings = false;
ui.on('settings', () => {
  inSettings = true;
  sound.resume();
  sound.engine(0, 0);
  sound.surface(null, 0);
  ui.show('settings');
});
function closeSettings(): void {
  inSettings = false;
  sound.suspend();
  ui.show('pause');
}
ui.on('settings-back', closeSettings);
// The list of controls also opens on top of the pause menu and goes back to it.
let inControls = false;
ui.on('controls', () => {
  inControls = true;
  ui.show('controls');
});
function closeControls(): void {
  inControls = false;
  ui.show('pause');
}
ui.on('controls-back', closeControls);
// The Escape key pauses a race, and steps back out again: settings or controls to the pause menu, that to the race.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat || mode !== 'race') return;
  if (!paused) pause();
  else if (inSettings) closeSettings();
  else if (inControls) closeControls();
  else resume();
});
// Pause automatically when the app goes to the background.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

startDemo();
ui.show('title');
// Browsers only allow sound after a tap, so the title theme starts with the first touch anywhere.
window.addEventListener(
  'pointerdown',
  () => {
    sound.unlock();
    // The theme was asked for before sound was allowed; ask again now that it is.
    if (mode === 'demo') {
      sound.stopMusic();
      sound.playMusic('theme');
    }
  },
  { once: true },
);

// ---- Simulation -----------------------------------------------------------------
/** 1 = leading. Karts that have finished keep their finishing place. */
function placeOf(kart: Kart): number {
  if (kart.place) return kart.place;
  let ahead = 0;
  for (const other of karts) {
    if (other !== kart && (other.place || other.progress > kart.progress)) ahead++;
  }
  return ahead + 1;
}

function updateDemo(dt: number, time: number): void {
  for (const kart of karts) kart.step(track, kart.autoSteer(track), 1, dt);
  separate(karts, track);
  items.update(dt, time, placeOf);
  sound.engine(0, 0);
  sound.surface(null, 0);
}

function updateRace(dt: number, time: number): void {
  if (phase === 'countdown') {
    countdown -= dt;
    const n = Math.ceil(countdown);
    if (n !== countdownShown && n > 0) {
      countdownShown = n;
      sound.countdown();
    }
    if (countdown <= 0) {
      phase = 'racing';
      goTimer = 0.9;
      sound.go();
    }
  } else {
    goTimer = Math.max(0, goTimer - dt);

    // After the finish the player's kart drives itself on a victory lap.
    // After the finish (and in capture mode) the player's kart drives itself.
    player.step(track, phase === 'racing' && !CAPTURE ? input.steer : player.autoSteer(track), 1, dt);
    // Coming down from a jump: a splash into water, a thump onto anything else.
    if (player.landedOn === 'water') sound.splash();
    else if (player.landedOn) sound.land();
    if (player.hitPad) sound.boost();
    if (player.hitRock) sound.bump();
    for (const rival of rivals) {
      const gap = rival.progress - player.progress;
      const band = Math.max(RUBBER_BAND_MIN, Math.min(RUBBER_BAND_MAX, 1 - gap / RUBBER_BAND_GAP));
      rival.step(track, rival.autoSteer(track), band, dt);
    }
    separate(karts, track);
    items.update(dt, time, placeOf);

    for (const kart of karts) {
      if (!kart.place && kart.progress >= track.layout.laps * track.count) kart.place = ++finishers;
    }
    if (phase === 'racing' && player.place && !CAPTURE) {
      phase = 'finished';
      // The standings at the moment the player crosses the line: finishers in
      // order, then everyone still racing by how far round they are.
      const order = [...karts].sort((a, b) => placeOf(a) - placeOf(b)).map((kart) => kart.id);
      ui.setFinish(order, player.id);
      ui.show('finish');
      sound.finish();
      voice.say(`finish.${player.place}` as VoiceLine);
    }
  }

  const lap = Math.min(track.layout.laps, Math.floor(Math.max(0, player.progress) / track.count) + 1);
  if (lap > lapShown && phase === 'racing') sound.lap();
  lapShown = lap;
  ui.setLap(lap, track.layout.laps);
  ui.setPlace(placeOf(player), karts.length);
  ui.setBanner(phase === 'countdown' ? String(Math.ceil(countdown)) : goTimer > 0 ? 'GO!' : '');
  const shown = items.playerDisplay(time);
  ui.setItem(
    shown,
    shown ? itemKit.names.indexOf(shown) : -1,
    itemKit.names.length,
    phase === 'racing' && items.playerReady(),
  );
  const pace = player.speed / player.topSpeed;
  sound.engine(pace, phase === 'finished' ? 0.4 : 1);
  // What the wheels are on. Silent in the air (off the waterfall, or carried by the pterodactyl).
  let under: SurfaceLoopId | null = null;
  if (!player.airborne && player.fly <= 0) {
    const on = track.onBridge(player.index) ? 'bridge' : track.query(player.x, player.z, player.index).surface;
    under = track.theme.sounds[on];
  }
  sound.surface(under, phase === 'finished' ? pace * 0.4 : pace);
}

const DEG = 180 / Math.PI;
/** The height the camera is following: the player's, smoothed so drops and climbs feel soft. */
let camBase = 0;

function render(time: number): void {
  const racing = mode === 'race';
  const back = racing ? CAM_BACK + NARROW_CAM_BACK * narrow : DEMO_CAM_BACK;
  const height = racing ? CAM_HEIGHT + NARROW_CAM_HEIGHT * narrow : DEMO_CAM_HEIGHT;
  const fx = Math.cos(player.heading);
  const fz = Math.sin(player.heading);
  // Follow the player's height with a little lag; snap if it is a long way off (a new race).
  camBase = Math.abs(player.y - camBase) > 60 ? player.y : camBase + (player.y - camBase) * 0.1;
  const camX = player.x - fx * back;
  const camZ = player.z - fz * back;
  // Behind the kart, but never underground: after the waterfall the camera is still up on the cliff.
  const camY = Math.max(camBase + height, track.heightAt(camX, camZ) + CAM_CLEARANCE);
  camera.position.set(camX, camY, camZ);
  camera.lookAt(player.x + fx * CAM_LOOK_AHEAD, camBase + 5, player.z + fz * CAM_LOOK_AHEAD);
  sky.follow(camera);

  // Widen the view during a boost for a sense of speed.
  const fov =
    CAM_FOV +
    (racing ? NARROW_CAM_FOV * narrow : 0) +
    (racing && (player.boost > 0 || player.fly > 0) ? CAM_BOOST_FOV : 0);
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov += (fov - camera.fov) * 0.12;
    camera.updateProjectionMatrix();
  }

  karts.forEach((kart, i) => {
    // Tiny engine wobble, only while moving.
    const bob = kart.speed > 5 && Math.floor(time * 14 + i * 0.5) % 2 === 0 ? 0.25 : 0;
    kart.sprite.sprite.position.set(kart.x, kart.y + bob + kart.lift, kart.z);
    shadows[i].position.set(kart.x, kart.ground + 0.25, kart.z);

    // A kart that has been hit, or has driven through tar, spins round.
    const spin = kart.spinAngle;

    if (kart === player) {
      // Always seen from behind; lean the sprite into the turn.
      // On ice the kart swings further round than it is travelling: show the slide.
      const lean = Math.abs(kart.steer) > 0.35 ? Math.sign(kart.steer) * STEER_VIEW_ANGLE : 0;
      const slide = kart.drift * DEG;
      kart.sprite.setView((Math.abs(slide) > Math.abs(lean) ? slide : lean) + spin);
      // In case this kart was a faded rival in the last race.
      kart.sprite.setOpacity(1);
      shadows[i].visible = true;
    } else {
      // How far in front of the lens this kart is, along the direction we are looking.
      const depth = (kart.x - camera.position.x) * fx + (kart.z - camera.position.z) * fz;
      const opacity = Math.max(0, Math.min(1, (depth - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
      kart.sprite.setOpacity(opacity);
      shadows[i].visible = opacity > 0.5;

      // Which side of another kart we see depends on where the camera is.
      const bearing = Math.atan2(kart.z - camera.position.z, kart.x - camera.position.x);
      const view = Math.atan2(Math.sin(kart.heading - bearing), Math.cos(kart.heading - bearing));
      kart.sprite.setView(view * DEG + spin);
    }
  });

  renderer.render(scene, camera);
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // Behind the menus the film plays instead, so there is nothing to simulate or draw.
  if (!(mode === 'demo' && menuVideoPlaying)) {
    if (!paused) {
      if (mode === 'race') updateRace(dt, now / 1000);
      else updateDemo(dt, now / 1000);
    }
    water.update(now / 1000);
    render(now / 1000);
  }
  requestAnimationFrame(frame);
}

if (CAPTURE) {
  document.getElementById('ui')!.style.display = 'none';
  menuVideo.style.display = 'none';
  let clock = 0;
  const advance = (dt: number, draw: boolean) => {
    clock += dt;
    updateRace(dt, clock);
    if (!draw) return;
    water.update(clock);
    render(clock);
  };
  Object.assign(window, {
    __capture: {
      /**
       * Set up a shot: a race on `trackId` seen from behind `racerId`, run
       * forward (without drawing) until that kart reaches `waypoint`.
       */
      async shot(trackId: string, racerId: string, waypoint: number): Promise<void> {
        await loadTrack(trackId);
        startRace(racerId);
        phase = 'racing';
        const target = track.sampleAt(waypoint);
        // Until it has left the grid and come round to within a few samples of the spot.
        for (let n = 0; n < 6000 && (player.progress < 0 || track.ahead(player.index, target) > 3); n++) {
          advance(1 / 30, false);
        }
        // Let the camera settle on the kart's height before the first frame.
        for (let n = 0; n < 40; n++) render(clock);
      },
      /** Advance the race by `dt` seconds and draw it. */
      frame(dt: number): void {
        advance(dt, true);
      },
      /**
       * A picture of the scenery alone: no karts, with the camera standing at
       * `from` and looking at `to` (each x, height, z).
       */
      async view(trackId: string, from: [number, number, number], to: [number, number, number]): Promise<void> {
        await loadTrack(trackId);
        startRace(karts[0].id);
        karts.forEach((kart, i) => {
          kart.sprite.sprite.visible = false;
          shadows[i].visible = false;
        });
        water.update(1);
        camera.fov = CAM_FOV;
        camera.updateProjectionMatrix();
        camera.position.set(...from);
        camera.lookAt(...to);
        sky.follow(camera);
        renderer.render(scene, camera);
      },
    },
  });
} else {
  requestAnimationFrame(frame);
}
