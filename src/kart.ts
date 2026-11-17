import type { RacerSprite } from './sprites';
import type { Surface } from './layouts';
import type { Track } from './track';

const ACCEL = 70;
const DRAG = 110; // how fast a kart sheds speed when above the surface's limit
const TURN_RATE = 1.9; // rad/s at full lock
const STEER_SMOOTH = 9; // higher = snappier steering response
/** Steering at full lock costs this fraction of top speed, so straight lines are fastest. */
const TURN_SLOWDOWN = 0.14;
/** Fraction of top speed available on each surface. */
const SURFACE_SPEED: Record<Surface, number> = { road: 1, water: 0.92, ice: 1.04, lake: 1.02, grass: 0.5 };
/**
 * Grip: how quickly the direction a kart is actually travelling catches up
 * with the way it is pointing. High = it goes where it points. Low = it slides:
 * turn the wheel on ice and the kart swings round first, then drifts into the
 * new line. Slippery, but it always comes round.
 */
const GRIP: Record<Surface, number> = { road: 30, water: 14, ice: 3.8, lake: 4.8, grass: 30 };
/** Hitting a rock knocks the kart back to this fraction of its speed. */
const ROCK_SPEED = 0.45;
/** How close a kart's middle gets to the edge of a rock before it counts as a hit. */
const KART_RADIUS = 5;
/** A computer driver steers round a rock that is within this many units of its line. */
const ROCK_AVOID = 20;
/** How hard a kart falls once the ground drops away beneath it. */
const GRAVITY = 170;
/** The ground has to fall away by more than this in one step for the kart to leave it. */
const TAKE_OFF_DROP = 1.2;
/** Falls shorter than this don't count as a landing worth a splash. */
const SPLASH_FALL = 12;

/** How long a kart spins after hitting a bone or a rolling egg. */
const SPIN_TIME = 1.1;
/** Full turns a kart makes while spinning out or sliding through tar. */
const SPIN_TURNS = 2;
/** A spinning kart slows to this speed. */
const SPIN_SPEED = 18;
/** Top-speed multiplier while boosting; a boost also ignores sand and grass. */
const BOOST_SPEED = 1.45;
/**
 * Driving through tar: the kart keeps sliding forwards but spins round for
 * this long, with no steering, and scrubs off speed down to this fraction of
 * its top speed. Then it drives on.
 */
const TAR_TIME = 1.3;
const TAR_SPEED = 0.45;
/** Pterodactyl ride: how long it lasts, how fast it flies and how high it lifts the kart. */
export const FLY_TIME = 3.2;
const FLY_SPEED = 260;
const FLY_HEIGHT = 13;
const FLY_TURN = 5; // rad/s; how sharply the pterodactyl follows the road

/** Karts closer than this push each other apart... */
const BUMP_RADIUS = 11;
/** ...unless one is this far above the other, on the bridge. */
const BUMP_HEIGHT = 14;
/** How long the burst of speed from a boost pad lasts. */
const PAD_BOOST_TIME = 1.1;

/** How many centre-line samples ahead a computer driver aims. */
const AI_LOOK_AHEAD = 10;

export class Kart {
  x = 0;
  z = 0;
  /** Height above the start line. Follows the ground, except in mid-air off the waterfall. */
  y = 0;
  /** True while the kart is falling through the air. */
  airborne = false;
  /** Set for one step when the kart comes down from a real drop: 'water' or 'road'. */
  landedOn: Surface | null = null;
  /** Set for one step when the kart drives onto a boost pad. */
  hitPad = false;
  /** Set for one step when the kart bumps into a rock. */
  hitRock = false;
  private onRock = false;
  /**
   * The direction the kart is actually moving, in radians. On grippy ground
   * this is the same as `heading`; on ice it lags behind, which is the slide.
   */
  travel = 0;
  /** Height of whatever is directly under the kart (for its shadow). */
  ground = 0;
  private onPad = false;
  private fallSpeed = 0;
  private fallFrom = 0;
  /** Radians. Forward is (cos, sin) in (x, z); increasing turns right. */
  heading = 0;
  speed = 0;
  /** Smoothed steering, -1 (left) to 1 (right). */
  steer = 0;
  /**
   * Distance travelled around the track in centre-line samples, counted
   * continuously across laps. Negative on the grid, 0 at the start line.
   */
  progress = 0;
  /** Seconds left spinning out. */
  spin = 0;
  /** Seconds of speed boost left. */
  boost = 0;
  /** Seconds left sliding and spinning after driving through tar. */
  slow = 0;
  /** Seconds left being carried by the pterodactyl. */
  fly = 0;
  /** Finishing place (1 = winner), or 0 while still racing. */
  place = 0;
  private lastIndex = 0;

  /** Top speed on tarmac. */
  topSpeed = 100;
  /** Sideways offset from the centre line that a computer driver holds. */
  lane = 0;

  constructor(
    readonly id: string,
    readonly sprite: RacerSprite,
  ) {}

  /** Put the kart on the track at a sample, `lane` units right of the centre line. */
  placeOnGrid(track: Track, index: number, lane: number): void {
    const h = track.headingAt(index);
    this.x = track.xs[index] - Math.sin(h) * lane;
    this.z = track.zs[index] + Math.cos(h) * lane;
    this.heading = h;
    this.travel = h;
    this.speed = 0;
    this.steer = 0;
    this.spin = 0;
    this.boost = 0;
    this.slow = 0;
    this.fly = 0;
    this.place = 0;
    this.lastIndex = ((index % track.count) + track.count) % track.count;
    this.ground = this.y = track.groundAt(this.x, this.z, this.lastIndex);
    this.airborne = false;
    this.landedOn = null;
    this.hitPad = false;
    this.onPad = false;
    this.hitRock = false;
    this.onRock = false;
    this.fallSpeed = 0;
    this.progress = index - track.count; // the grid sits just before the line
  }

  /** The centre-line sample the kart is on. */
  get index(): number {
    return this.lastIndex;
  }

  /** How far the kart is pointing away from the way it is moving, in radians (positive = nose to the right). */
  get drift(): number {
    const d = this.heading - this.travel;
    return Math.atan2(Math.sin(d), Math.cos(d));
  }

  /** How far off the ground the kart is: it rises and lands smoothly at each end of a flight. */
  get lift(): number {
    if (this.fly <= 0) return 0;
    const ease = Math.min(1, this.fly / 0.35, (FLY_TIME - this.fly) / 0.35);
    return FLY_HEIGHT * ease * (2 - ease);
  }

  /** How far round, in degrees, the kart has visibly spun while spinning out or sliding in tar. */
  get spinAngle(): number {
    if (this.spin > 0) return (1 - this.spin / SPIN_TIME) * SPIN_TURNS * 360;
    if (this.slow > 0) return (1 - this.slow / TAR_TIME) * SPIN_TURNS * 360;
    return 0;
  }

  /** Nothing can hit a kart that is being carried through the air. */
  get untouchable(): boolean {
    return this.fly > 0;
  }

  /**
   * Advance one step. `steerInput` is -1..1; `speedScale` multiplies top speed
   * (used to keep computer drivers close to the player).
   */
  step(track: Track, steerInput: number, speedScale: number, dt: number): void {
    this.landedOn = null;
    this.hitPad = false;
    this.hitRock = false;
    if (this.fly > 0) {
      this.flyStep(track, dt);
      // Carried at a steady height above whatever is below.
      this.ground = this.y = track.groundAt(this.x, this.z, this.lastIndex);
      this.airborne = false;
      return;
    }
    const spinning = this.spin > 0;
    const sliding = this.slow > 0;
    this.spin = Math.max(0, this.spin - dt);
    this.boost = Math.max(0, this.boost - dt);
    this.slow = Math.max(0, this.slow - dt);
    // No steering while the kart is going round: it carries on the way it was heading.
    if (spinning || sliding) steerInput = 0;

    // Smooth on/off input into a steering value so turns ease in and out.
    this.steer += (steerInput - this.steer) * Math.min(1, STEER_SMOOTH * dt);

    const here = track.query(this.x, this.z, this.lastIndex);
    let max = this.topSpeed * speedScale * SURFACE_SPEED[here.surface];
    let accel = ACCEL;
    let drag = DRAG;
    if (spinning) {
      max = SPIN_SPEED;
      drag = DRAG * 2;
    } else if (this.boost > 0) {
      max = this.topSpeed * BOOST_SPEED;
      accel = ACCEL * 3;
    }
    if (!spinning) {
      max *= 1 - TURN_SLOWDOWN * Math.abs(this.steer);
      // In tar the speed bleeds away at the normal rate as the kart spins, rather than all at once.
      if (sliding) max = this.topSpeed * TAR_SPEED;
    }
    if (this.speed < max) this.speed = Math.min(max, this.speed + accel * dt);
    else this.speed = Math.max(max, this.speed - drag * dt);

    // Less steering authority at a crawl so the kart doesn't spin on the spot.
    const grip = Math.min(1, this.speed / 40);
    this.heading += this.steer * TURN_RATE * grip * dt;

    // The kart moves the way it is travelling, which swings round to match the
    // way it is pointing: at once on a grippy surface, lazily on ice.
    this.travel += this.drift * (1 - Math.exp(-GRIP[here.surface] * dt));
    this.x += Math.cos(this.travel) * this.speed * dt;
    this.z += Math.sin(this.travel) * this.speed * dt;
    this.bumpRocks(track);
    this.settle(track);
    this.followGround(track, dt);

    // Boost pads: a burst of speed the moment the kart drives onto one.
    const pad = !this.airborne && !spinning && track.onBoostPad(this.x, this.z, this.lastIndex);
    if (pad && !this.onPad) {
      this.boost = Math.max(this.boost, PAD_BOOST_TIME);
      this.hitPad = true;
    }
    this.onPad = pad;
  }

  /** Rocks on the road: the kart is pushed back out of any it touches, and loses speed once per bump. */
  private bumpRocks(track: Track): void {
    let touching = false;
    for (const rock of track.rocks) {
      if (Math.abs(this.y - rock.y) > BUMP_HEIGHT) continue;
      const dx = this.x - rock.x;
      const dz = this.z - rock.z;
      const d = Math.hypot(dx, dz);
      const reach = rock.radius + KART_RADIUS;
      if (d >= reach || d === 0) continue;
      touching = true;
      this.x = rock.x + (dx / d) * reach;
      this.z = rock.z + (dz / d) * reach;
    }
    if (touching && !this.onRock) {
      this.speed *= ROCK_SPEED;
      this.boost = 0;
      this.hitRock = true;
    }
    this.onRock = touching;
  }

  /**
   * Keep the kart on the ground, or let it fall if the ground has dropped away
   * (the waterfall). There is nothing to get wrong: it just sails off the lip
   * and lands in the river below.
   */
  private followGround(track: Track, dt: number): void {
    const ground = track.groundAt(this.x, this.z, this.lastIndex);
    this.ground = ground;
    if (!this.airborne && this.y - ground > TAKE_OFF_DROP) {
      this.airborne = true;
      this.fallSpeed = 0;
      this.fallFrom = this.y;
    }
    if (!this.airborne) {
      this.y = ground;
      return;
    }
    this.fallSpeed += GRAVITY * dt;
    this.y -= this.fallSpeed * dt;
    if (this.y <= ground) {
      this.y = ground;
      this.airborne = false;
      if (this.fallFrom - ground > SPLASH_FALL) {
        this.landedOn = track.query(this.x, this.z, this.lastIndex).surface;
      }
    }
  }

  /** Being carried: the pterodactyl flies the kart down the middle of the road by itself. */
  private flyStep(track: Track, dt: number): void {
    this.fly = Math.max(0, this.fly - dt);
    this.spin = 0;
    this.slow = 0;
    this.steer += (0 - this.steer) * Math.min(1, STEER_SMOOTH * dt);
    const turn = this.aim(track, 0);
    this.heading += Math.max(-FLY_TURN * dt, Math.min(FLY_TURN * dt, turn));
    this.travel = this.heading;
    this.speed = Math.min(FLY_SPEED, this.speed + ACCEL * 6 * dt);
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.z += Math.sin(this.heading) * this.speed * dt;
    this.settle(track);
    // Set down at a sensible driving speed.
    if (this.fly <= 0) this.speed = this.topSpeed;
  }

  /** Hit by an item: spin on the spot for a moment and lose any boost. Returns false if it had no effect. */
  spinOut(): boolean {
    if (this.untouchable) return false;
    if (this.spin <= 0) this.spin = SPIN_TIME;
    this.boost = 0;
    return true;
  }

  /** Drove into tar. Returns true if this is the moment the kart started to slide. */
  stickInTar(): boolean {
    if (this.untouchable || this.slow > 0 || this.spin > 0) return false;
    this.slow = TAR_TIME;
    this.boost = 0;
    return true;
  }

  /** Apply the soft wall and update lap progress after the kart has moved. */
  settle(track: Track): void {
    const q = track.query(this.x, this.z, this.lastIndex);
    const wall = track.wallAt(q.index);
    if (q.dist > wall) {
      const k = wall / q.dist;
      this.x = q.x + (this.x - q.x) * k;
      this.z = q.z + (this.z - q.z) * k;
    }
    // Progress is the change in nearest sample, taking the short way round so
    // crossing the start line counts as +1 rather than -399.
    let delta = q.index - this.lastIndex;
    if (delta > track.count / 2) delta -= track.count;
    else if (delta < -track.count / 2) delta += track.count;
    this.progress += delta;
    this.lastIndex = q.index;
  }

  /** The turn, in radians, needed to point at the road ahead, `lane` units right of its centre. */
  private aim(track: Track, lane: number): number {
    const target = (this.lastIndex + AI_LOOK_AHEAD) % track.count;
    const h = track.headingAt(target);
    const tx = track.xs[target] - Math.sin(h) * lane;
    const tz = track.zs[target] + Math.cos(h) * lane;
    const diff = Math.atan2(tz - this.z, tx - this.x) - this.heading;
    return Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to -PI..PI
  }

  /** Steering a computer driver would apply right now, -1..1. */
  autoSteer(track: Track): number {
    // Hold the usual lane, but move over for the next rock if it is on that line.
    let lane = this.lane;
    let nearest = AI_LOOK_AHEAD * 3.5; // far enough ahead to move over in time, even sliding on ice
    for (const rock of track.rocks) {
      const gap = track.ahead(this.lastIndex, rock.sample);
      if (gap > nearest) continue;
      nearest = gap;
      // Pass on whichever side there is more road.
      lane = Math.abs(rock.lane - this.lane) > ROCK_AVOID ? this.lane : rock.lane + (rock.lane > 0 ? -1 : 1) * (ROCK_AVOID + 6);
    }
    return Math.max(-1, Math.min(1, this.aim(track, lane) * 2.5));
  }
}

/** Gently push apart any karts that overlap, so they bump instead of passing through. */
export function separate(karts: Kart[], track: Track): void {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i];
      const b = karts[j];
      if (a.untouchable || b.untouchable) continue; // a flying kart passes overhead
      if (Math.abs(a.y - b.y) > BUMP_HEIGHT) continue; // one is on the bridge, the other under it
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d >= BUMP_RADIUS || d === 0) continue;
      const push = (BUMP_RADIUS - d) / 2;
      a.x -= (dx / d) * push;
      a.z -= (dz / d) * push;
      b.x += (dx / d) * push;
      b.z += (dz / d) * push;
      a.settle(track);
      b.settle(track);
    }
  }
}
