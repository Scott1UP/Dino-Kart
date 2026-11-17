import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import './style.css';
import * as THREE from 'three';
import { sound, type SurfaceSound } from './audio';
import { Input } from './input';
import { ItemSystem, type ItemEvent } from './items';
import { Kart, separate } from './kart';
import { makeRng } from './rng';
import { HAZE, SKY_TOP, makeSky } from './sky';
import { loadKit, loadRacer, type SpriteKit } from './sprites';
import { GRASS, ROAD_HALF, Track, WALL_DIST } from './track';
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
const LAPS = 3;
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

const TREE_COUNT = 520;
const BUSH_COUNT = 140;
const BOULDER_COUNT = 60;
/** The camera never dips closer to the ground than this (it would end up inside a cliff). */
const CAM_CLEARANCE = 7;

// ---- Renderer -----------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
scene.background = new THREE.Color(SKY_TOP);
scene.fog = new THREE.Fog(HAZE, 320, 1700);
const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 1, 6000);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale = retro ? RETRO_RES / Math.min(w, h) : Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setSize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- World --------------------------------------------------------------------
const track = new Track();
track.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

scene.add(track.makeGround(), track.makeFences(), track.makeBridge());
const water = track.makeWater();
scene.add(water.object);

// Plain grass out to the horizon, beyond the edge of the terrain.
const outer = new THREE.Mesh(
  new THREE.PlaneGeometry(12000, 12000),
  new THREE.MeshBasicMaterial({ color: GRASS }),
);
outer.rotation.x = -Math.PI / 2;
outer.position.set(track.centre.x, -0.5, track.centre.z);
scene.add(outer);

const sky = makeSky();
scene.add(sky.mesh);

/** Stand a scenery sprite on the ground at a point. */
function place(sprite: THREE.Sprite, x: number, z: number): void {
  sprite.position.set(x, track.heightAt(x, z), z);
  scene.add(sprite);
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
    const heading = track.headingAt(i);
    const side = rand() < 0.5 ? -1 : 1;
    const offset = WALL_DIST + near + rand() * rand() * (far - near); // denser close to the track
    const x = track.xs[i] - Math.sin(heading) * offset * side;
    const z = track.zs[i] + Math.cos(heading) * offset * side;
    // The point can land near a different stretch of road, especially inside bends.
    if (track.query(x, z).dist < WALL_DIST + near - 2) continue;
    place(make(rand), x, z);
    planted++;
  }
}

function buildScenery(trees: SpriteKit, props: SpriteKit): void {
  // Jungle, thickest right beside the road.
  scatter(TREE_COUNT, 8, 190, 7, (rand) => {
    const pick = rand();
    return pick < 0.45
      ? trees.make('palm', 58 + rand() * 24, rand() < 0.5)
      : pick < 0.7
        ? trees.make('cycad', 30 + rand() * 12, rand() < 0.5)
        : trees.make('fern', 11 + rand() * 6, rand() < 0.5);
  });
  scatter(BUSH_COUNT, 5, 70, 21, (rand) => props.make('bush', 10 + rand() * 7, rand() < 0.5));
  scatter(BOULDER_COUNT, 7, 120, 33, (rand) => props.make('boulder', 9 + rand() * 20, rand() < 0.5));

  // The landmarks from the track design, inside the west loop.
  place(props.make('volcano', 190), 540, 640);
  place(props.make('skull', 60), 650, 905);
  place(props.make('nest', 28), 385, 860);
  // Dinosaurs watching from the outside of the big corners.
  place(props.make('brachio', 120), 140, 190);
  place(props.make('trike', 48, true), 1895, 400);
  place(props.make('trike', 40), 1420, 1140);

  // Start line: a banner over the road with torches along the straight.
  const bannerWidth = ROAD_HALF * 2 + 34;
  place(props.make('banner', bannerWidth / props.aspect('banner')), track.xs[0], track.zs[0]);
  for (let n = 0; n < 4; n++) {
    const sample = track.count - 6 + n * 24;
    for (const side of [-1, 1]) place(props.make('torch', 24), ...track.beside(sample, side * (ROAD_HALF + 12)));
  }

  // Arrow signs on the outside of the corners, pointing the way the road turns.
  for (const waypoint of [2.6, 7.6, 12.4, 19.6, 23.5, 26.6, 30.2, 35.6]) {
    const sample = track.sampleAt(waypoint);
    const turn = track.headingAt(sample + 14) - track.headingAt(sample - 14);
    const right = Math.atan2(Math.sin(turn), Math.cos(turn)) > 0;
    // The sign's arrow points right as drawn; mirrored for a left-hand corner.
    place(props.make('sign', 22, !right), ...track.beside(sample, (right ? -1 : 1) * (WALL_DIST + 12)));
  }
}

// ---- Racers ------------------------------------------------------------------
const [racerSprites, scenery, props, itemKit] = await Promise.all([
  Promise.all(RACER_IDS.map((id) => loadRacer(id, KART_SIZE))),
  loadKit('scenery'),
  loadKit('props'),
  loadKit('items'),
]);
buildScenery(scenery, props);

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
const items = new ItemSystem(scene, track, itemKit, karts, onItemEvent);

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
  sound.stopMusic();
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
  sound.startMusic();
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
    startRace(id);
  },
);
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
ui.on('resume', () => {
  paused = false;
  sound.resume();
  ui.show('race');
});
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
ui.on('exit', () => {
  sound.resume();
  startDemo();
  ui.show('title');
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
ui.on('settings', () => {
  sound.resume();
  sound.engine(0, 0);
  sound.surface(null, 0);
  ui.show('settings');
});
ui.on('settings-back', () => {
  sound.suspend();
  ui.show('pause');
});
// Pause automatically when the app goes to the background.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

startDemo();
ui.show('title');

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
    player.step(track, phase === 'racing' ? input.steer : player.autoSteer(track), 1, dt);
    if (player.landedOn === 'water') sound.splash();
    if (player.hitPad) sound.boost();
    for (const rival of rivals) {
      const gap = rival.progress - player.progress;
      const band = Math.max(RUBBER_BAND_MIN, Math.min(RUBBER_BAND_MAX, 1 - gap / RUBBER_BAND_GAP));
      rival.step(track, rival.autoSteer(track), band, dt);
    }
    separate(karts, track);
    items.update(dt, time, placeOf);

    for (const kart of karts) {
      if (!kart.place && kart.progress >= LAPS * track.count) kart.place = ++finishers;
    }
    if (phase === 'racing' && player.place) {
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

  const lap = Math.min(LAPS, Math.floor(Math.max(0, player.progress) / track.count) + 1);
  if (lap > lapShown && phase === 'racing') sound.lap();
  lapShown = lap;
  ui.setLap(lap, LAPS);
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
  let under: SurfaceSound | null = null;
  if (!player.airborne && player.fly <= 0) {
    under = track.onBridge(player.index) ? 'bridge' : track.query(player.x, player.z, player.index).surface;
  }
  sound.surface(under, phase === 'finished' ? pace * 0.4 : pace);
}

const DEG = 180 / Math.PI;
/** The height the camera is following: the player's, smoothed so drops and climbs feel soft. */
let camBase = 0;

function render(time: number): void {
  const racing = mode === 'race';
  const back = racing ? CAM_BACK : DEMO_CAM_BACK;
  const height = racing ? CAM_HEIGHT : DEMO_CAM_HEIGHT;
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
  const fov = CAM_FOV + (racing && (player.boost > 0 || player.fly > 0) ? CAM_BOOST_FOV : 0);
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
      const lean = Math.abs(kart.steer) > 0.35 ? Math.sign(kart.steer) * STEER_VIEW_ANGLE : 0;
      kart.sprite.setView(lean + spin);
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
  if (!paused) {
    if (mode === 'race') updateRace(dt, now / 1000);
    else updateDemo(dt, now / 1000);
  }
  water.update(now / 1000);
  render(now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
