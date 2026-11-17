import * as THREE from 'three';
import { FLY_TIME, type Kart } from './kart';
import type { SpriteKit } from './sprites';
import type { Track } from './track';

/**
 * Items. Drive through a rainbow egg to get one. The player keeps it until
 * they press the fire button; computer drivers use theirs after a short wait.
 *
 *  - bone:      dropped on the road behind you; whoever drives over it spins out
 *  - drumstick: a burst of speed
 *  - egg:       rolls off in a straight line, bouncing off the walls, and spins
 *               out the first kart it hits
 *  - tar:       a puddle dropped behind you that stays for the whole race;
 *               anyone who drives through it slides on, spinning and losing speed
 *  - ptero:     a pterodactyl carries you down the road, fast and untouchable
 */
export type ItemType = 'bone' | 'drumstick' | 'egg' | 'tar' | 'ptero';
const ITEM_TYPES: ItemType[] = ['bone', 'drumstick', 'egg', 'tar', 'ptero'];

/** Sideways positions of the eggs in each row, relative to the centre line. */
const BOX_LANES = [-26, 0, 26];
const BOX_HEIGHT = 9;
const BOX_RADIUS = 10;
const BOX_RESPAWN = 3;

const ROULETTE_TIME = 1.3;

const BOOST_TIME = 2.2;

const BONE_HEIGHT = 5;
const BONE_RADIUS = 8;
const DROP_BEHIND = 13;
const MAX_BONES = 12;

const TAR_RADIUS = 10;
const MAX_TAR = 8;

const EGG_HEIGHT = 7;
const EGG_RADIUS = 9;
const EGG_SPEED = 210;
/** Things only touch if they are within this height of each other (so not across the bridge). */
const REACH_HEIGHT = 14;
/** Each bounce is deflected by up to half this many radians either way. */
const EGG_BOUNCE_WOBBLE = 0.5;
const EGG_MAX_BOUNCES = 10;
const EGG_LIFE = 9;
const EGG_START_AHEAD = 14;

/** Wingspan of the pterodactyl that carries a kart, and how far above the kart it flies. */
const PTERO_HEIGHT = 16;
const PTERO_ABOVE = 11;

/** Things that happen, for sound: `tar` is dropping a puddle, `stuck` is driving into one. */
export type ItemEvent = 'pickup' | 'got' | 'bone' | 'boost' | 'egg' | 'tar' | 'ptero' | 'hit' | 'stuck';

interface Box {
  sprite: THREE.Sprite;
  x: number;
  /** Height of the ground it floats over. */
  y: number;
  z: number;
  /** Seconds until it reappears; 0 = available. */
  respawn: number;
  phase: number;
}

interface Dropped {
  object: THREE.Object3D;
  x: number;
  y: number;
  z: number;
}

interface RollingEgg {
  sprite: THREE.Sprite;
  x: number;
  z: number;
  y: number;
  heading: number;
  /** The centre-line sample it is rolling along, so it stays on its own level at the bridge. */
  index: number;
  life: number;
  bounces: number;
  owner: Kart;
}

interface Holder {
  /** Seconds of roulette left; the item is chosen when it reaches 0. */
  roulette: number;
  held: ItemType | null;
  /** Seconds until a computer driver uses the held item. */
  useIn: number;
}

// A tar puddle lies flat on the road, so it is a simple dark disc with a
// shiny highlight rather than an upright sprite.
const tarGeometry = new THREE.CircleGeometry(TAR_RADIUS, 20);
const tarMaterial = new THREE.MeshBasicMaterial({ color: 0x14101c });
const tarShineGeometry = new THREE.CircleGeometry(TAR_RADIUS * 0.3, 12);
const tarShineMaterial = new THREE.MeshBasicMaterial({ color: 0x5a5470 });

function makeTarPuddle(): THREE.Object3D {
  const puddle = new THREE.Group();
  const disc = new THREE.Mesh(tarGeometry, tarMaterial);
  disc.rotation.x = -Math.PI / 2;
  const shine = new THREE.Mesh(tarShineGeometry, tarShineMaterial);
  shine.rotation.x = -Math.PI / 2;
  shine.position.set(-TAR_RADIUS * 0.3, 0.05, -TAR_RADIUS * 0.3);
  puddle.add(disc, shine);
  return puddle;
}

export class ItemSystem {
  private readonly boxes: Box[] = [];
  private bones: Dropped[] = [];
  private tar: Dropped[] = [];
  private eggs: RollingEgg[] = [];
  private readonly holders = new Map<Kart, Holder>();
  /** The pterodactyl sprite above each kart that is being carried. */
  private readonly carriers = new Map<Kart, THREE.Sprite>();
  /** The human driver: their item shows in the HUD and waits for `firePlayer`. */
  player: Kart | null = null;

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly track: Track,
    private readonly kit: SpriteKit,
    private readonly karts: Kart[],
    /** Called when something happens that deserves a sound. */
    private readonly onEvent: (event: ItemEvent, kart: Kart) => void,
  ) {
    for (const index of track.itemRows) {
      for (const lane of BOX_LANES) {
        const sprite = kit.make('box', BOX_HEIGHT);
        const [x, z] = track.beside(index, lane);
        const y = track.groundAt(x, z, index);
        sprite.position.set(x, y, z);
        scene.add(sprite);
        this.boxes.push({ sprite, x, y, z, respawn: 0, phase: this.boxes.length * 1.7 });
      }
    }
    for (const kart of karts) this.holders.set(kart, { roulette: 0, held: null, useIn: 0 });
  }

  /** Clear everything for a new race. */
  reset(): void {
    for (const box of this.boxes) {
      box.respawn = 0;
      box.sprite.visible = true;
    }
    for (const bone of this.bones) this.scene.remove(bone.object);
    for (const puddle of this.tar) this.scene.remove(puddle.object);
    for (const egg of this.eggs) this.scene.remove(egg.sprite);
    for (const sprite of this.carriers.values()) this.scene.remove(sprite);
    this.bones = [];
    this.tar = [];
    this.eggs = [];
    this.carriers.clear();
    for (const holder of this.holders.values()) {
      holder.roulette = 0;
      holder.held = null;
      holder.useIn = 0;
    }
  }

  /**
   * What to show in the player's item slot: an item name, or null for empty.
   * While the roulette spins it flicks through the items.
   */
  playerDisplay(time: number): ItemType | null {
    const holder = this.player && this.holders.get(this.player);
    if (!holder) return null;
    if (holder.roulette > 0) return ITEM_TYPES[Math.floor(time * 12) % ITEM_TYPES.length];
    return holder.held;
  }

  /** True when the player is holding an item that can be fired right now. */
  playerReady(): boolean {
    const holder = this.player && this.holders.get(this.player);
    return !!holder && holder.roulette <= 0 && holder.held !== null && canUse(this.player!);
  }

  /** The player pressed the fire button. Returns whether an item was used. */
  firePlayer(): boolean {
    if (!this.player || !this.playerReady()) return false;
    const holder = this.holders.get(this.player)!;
    this.use(this.player, holder.held!);
    holder.held = null;
    return true;
  }

  /** `placeOf` gives a kart's current race position (1 = leading). */
  update(dt: number, time: number, placeOf: (kart: Kart) => number): void {
    this.updateBoxes(dt, time);
    this.updateHolders(dt, placeOf);
    this.updateDropped();
    this.updateEggs(dt, time);
    this.updateCarriers(time);
  }

  private updateBoxes(dt: number, time: number): void {
    for (const box of this.boxes) {
      if (box.respawn > 0) {
        box.respawn -= dt;
        if (box.respawn <= 0) box.sprite.visible = true;
        continue;
      }
      box.sprite.position.y = box.y + 2 + Math.sin(time * 3 + box.phase);
      for (const kart of this.karts) {
        if (kart.untouchable || !near(kart, box, BOX_RADIUS)) continue;
        // A kart that already has an item drives straight through and leaves
        // the egg for someone else, so nobody can hoard eggs to starve the rest.
        const holder = this.holders.get(kart)!;
        if (holder.roulette > 0 || holder.held) continue;
        box.respawn = BOX_RESPAWN;
        box.sprite.visible = false;
        holder.roulette = ROULETTE_TIME;
        this.onEvent('pickup', kart);
        break;
      }
    }
  }

  private updateHolders(dt: number, placeOf: (kart: Kart) => number): void {
    for (const [kart, holder] of this.holders) {
      if (holder.roulette > 0) {
        holder.roulette -= dt;
        if (holder.roulette <= 0) {
          holder.held = pickItem(placeOf(kart), this.karts.length);
          holder.useIn = 1 + Math.random() * 3;
          this.onEvent('got', kart);
        }
      } else if (holder.held && kart !== this.player) {
        holder.useIn -= dt;
        if (holder.useIn <= 0 && canUse(kart)) {
          this.use(kart, holder.held);
          holder.held = null;
        }
      }
    }
  }

  private use(kart: Kart, item: ItemType): void {
    const fx = Math.cos(kart.heading);
    const fz = Math.sin(kart.heading);
    this.onEvent(item === 'drumstick' ? 'boost' : item, kart);
    if (item === 'drumstick') {
      kart.boost = BOOST_TIME;
    } else if (item === 'ptero') {
      kart.fly = FLY_TIME;
      kart.boost = 0;
      const sprite = this.kit.make('ptero', PTERO_HEIGHT);
      this.scene.add(sprite);
      this.carriers.set(kart, sprite);
    } else if (item === 'bone' || item === 'tar') {
      const object = item === 'bone' ? this.kit.make('bone', BONE_HEIGHT) : makeTarPuddle();
      const x = kart.x - fx * DROP_BEHIND;
      const z = kart.z - fz * DROP_BEHIND;
      // Dropped at the height the kart is driving at, so on the bridge it lands on the deck.
      const y = kart.ground;
      object.position.set(x, y + (item === 'bone' ? 0 : 0.2), z);
      this.scene.add(object);
      const list = item === 'bone' ? this.bones : this.tar;
      list.push({ object, x, y, z });
      // Too many on the track at once: the oldest one disappears.
      if (list.length > (item === 'bone' ? MAX_BONES : MAX_TAR)) this.scene.remove(list.shift()!.object);
    } else {
      const sprite = this.kit.make('egg', EGG_HEIGHT);
      this.scene.add(sprite);
      this.eggs.push({
        sprite,
        x: kart.x + fx * EGG_START_AHEAD,
        y: kart.ground,
        z: kart.z + fz * EGG_START_AHEAD,
        heading: kart.heading,
        index: kart.index,
        life: EGG_LIFE,
        bounces: 0,
        owner: kart,
      });
    }
  }

  private updateDropped(): void {
    // A bone is used up by the first kart that hits it.
    this.bones = this.bones.filter((bone) => {
      for (const kart of this.karts) {
        if (!near(kart, bone, BONE_RADIUS)) continue;
        if (!kart.spinOut()) continue;
        this.onEvent('hit', kart);
        this.scene.remove(bone.object);
        return false;
      }
      return true;
    });
    // Tar stays where it is and catches everyone.
    for (const puddle of this.tar) {
      for (const kart of this.karts) {
        if (!near(kart, puddle, TAR_RADIUS)) continue;
        if (kart.stickInTar()) this.onEvent('stuck', kart);
      }
    }
  }

  private updateEggs(dt: number, time: number): void {
    const { track } = this;
    this.eggs = this.eggs.filter((egg) => {
      // Roll in a straight line...
      egg.x += Math.cos(egg.heading) * EGG_SPEED * dt;
      egg.z += Math.sin(egg.heading) * EGG_SPEED * dt;
      egg.life -= dt;

      // ...and bounce off the wall like a ball off a cushion.
      const here = track.query(egg.x, egg.z, egg.index);
      egg.index = here.index;
      const bounds = track.wallAt(here.index);
      if (here.dist > bounds) {
        // The wall's normal points straight out from the centre line.
        const nx = (egg.x - here.x) / here.dist;
        const nz = (egg.z - here.z) / here.dist;
        const vx = Math.cos(egg.heading);
        const vz = Math.sin(egg.heading);
        const outward = vx * nx + vz * nz;
        if (outward > 0) {
          // A little randomness in each bounce so no two eggs take the same path.
          const wobble = (Math.random() - 0.5) * EGG_BOUNCE_WOBBLE;
          egg.heading = Math.atan2(vz - 2 * outward * nz, vx - 2 * outward * nx) + wobble;
          egg.bounces++;
        }
        const k = bounds / here.dist;
        egg.x = here.x + (egg.x - here.x) * k;
        egg.z = here.z + (egg.z - here.z) * k;
      }
      egg.y = track.groundAt(egg.x, egg.z, egg.index);
      egg.sprite.position.set(egg.x, egg.y + Math.abs(Math.sin(time * 14)) * 1.5, egg.z);

      let done = egg.life <= 0 || egg.bounces > EGG_MAX_BOUNCES;
      for (const kart of this.karts) {
        // An egg never hits the kart that threw it.
        if (kart === egg.owner || !near(kart, egg, EGG_RADIUS)) continue;
        if (!kart.spinOut()) continue;
        this.onEvent('hit', kart);
        done = true;
        break;
      }
      if (done) this.scene.remove(egg.sprite);
      return !done;
    });
  }

  /** Keep each pterodactyl above the kart it is carrying, flapping, and remove it on landing. */
  private updateCarriers(time: number): void {
    for (const [kart, sprite] of this.carriers) {
      if (kart.fly <= 0) {
        this.scene.remove(sprite);
        this.carriers.delete(kart);
        continue;
      }
      sprite.position.set(kart.x, kart.y + kart.lift + PTERO_ABOVE + Math.sin(time * 10) * 0.8, kart.z);
    }
  }
}

/** Whether a kart is touching something: close enough on the map, and on the same level. */
function near(kart: Kart, thing: { x: number; y: number; z: number }, radius: number): boolean {
  return Math.hypot(kart.x - thing.x, kart.z - thing.z) <= radius && Math.abs(kart.y - thing.y) <= REACH_HEIGHT;
}

/** A kart can't use an item while it is spinning out, sliding in tar or already being carried. */
function canUse(kart: Kart): boolean {
  return kart.spin <= 0 && kart.slow <= 0 && kart.fly <= 0;
}

/**
 * The leader mostly gets things to drop behind; the middle of the pack gets a
 * mix; whoever is last gets the most help catching up.
 */
function pickItem(place: number, racers: number): ItemType {
  const table: [ItemType, number][] =
    place === 1
      ? [['bone', 40], ['tar', 30], ['egg', 20], ['drumstick', 10]]
      : place >= racers
        ? [['ptero', 45], ['drumstick', 35], ['egg', 20]]
        : [['drumstick', 32], ['egg', 28], ['bone', 15], ['tar', 13], ['ptero', 12]];
  let r = Math.random() * table.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [item, weight] of table) {
    r -= weight;
    if (r < 0) return item;
  }
  return table[0][0];
}
