/**
 * Sound effects, engine and music.
 *
 * Effects listed in public/audio/sfx/manifest.json (made by `npm run sfx`) are
 * played from their recordings. Anything not recorded falls back to a simple
 * sound synthesised with the Web Audio API, so the game is never silent. The
 * music is always synthesised.
 */

const STORAGE_KEY = 'dino-kart-sound';
const SFX = `${import.meta.env.BASE_URL}audio/sfx/`;

type Effect =
  | 'tap'
  | 'countdown'
  | 'go'
  | 'pickup'
  | 'gotItem'
  | 'drop'
  | 'boost'
  | 'throwEgg'
  | 'tar'
  | 'stuck'
  | 'ptero'
  | 'splash'
  | 'hit'
  | 'lap'
  | 'finish'
  | 'engine'
  | SurfaceLoop;

/** What the player's wheels are on; each has its own looping sound. */
export type SurfaceSound = 'road' | 'water' | 'bridge' | 'grass';
type SurfaceLoop = 'surfaceRoad' | 'surfaceWater' | 'surfaceBridge' | 'surfaceGrass';
const SURFACE_LOOPS: Record<SurfaceSound, SurfaceLoop> = {
  road: 'surfaceRoad',
  water: 'surfaceWater',
  bridge: 'surfaceBridge',
  grass: 'surfaceGrass',
};

/** Playback volume of each recorded effect. */
const VOLUME: Record<Effect, number> = {
  tap: 0.6,
  countdown: 0.6,
  go: 0.7,
  pickup: 0.6,
  gotItem: 0.6,
  drop: 0.7,
  boost: 0.7,
  throwEgg: 0.7,
  tar: 0.7,
  stuck: 0.7,
  ptero: 0.7,
  splash: 0.8,
  hit: 0.7,
  lap: 0.6,
  finish: 0.7,
  engine: 0.26,
  // The mix: surfaces sit under the engine and music. Dirt is a quiet bed that
  // is there most of the time; water, planks and grass are louder because they
  // are news ("you are somewhere different now").
  surfaceRoad: 0.09,
  surfaceWater: 0.34,
  surfaceBridge: 0.42,
  surfaceGrass: 0.24,
};

// ---- Music --------------------------------------------------------------------
// A bouncy marimba tune in D major, 16 bars long, with a bass line, off-beat
// chords and light percussion. Notes are semitones above the D above middle C;
// -1 is a rest. Each bar is 8 eighth-notes.
const TEMPO = 132;
const STEP = 60 / TEMPO / 2;
const note = (semitones: number) => 293.66 * 2 ** (semitones / 12);

const D = [0, 4, 7];
const G = [5, 9, 12];
const A = [7, 11, 14];
const Bm = [9, 12, 16];
const Em = [2, 5, 9];
// prettier-ignore
const BARS: { chord: number[]; tune: number[] }[] = [
  // A section
  { chord: D,  tune: [12, -1,  9, 12, 16, -1, 12,  9] },
  { chord: D,  tune: [ 7,  9, 12, -1,  9,  7,  4, -1] },
  { chord: G,  tune: [ 5, -1,  9, 12, 17, -1, 14, 12] },
  { chord: A,  tune: [11, 12, 14, -1, 11,  7, 14, -1] },
  { chord: D,  tune: [12, -1,  9, 12, 16, -1, 19, 16] },
  { chord: Bm, tune: [14, 11,  9, -1, 11, 14, 18, -1] },
  { chord: G,  tune: [17, 16, 14, 12,  9, -1, 12, 14] },
  { chord: A,  tune: [16, 14, 11, 14, 12, -1, -1, -1] },
  // B section
  { chord: G,  tune: [ 9, -1,  9, 12, 14, 12,  9, -1] },
  { chord: G,  tune: [ 5,  7,  9, -1, 12, -1,  9,  7] },
  { chord: D,  tune: [ 4, -1,  4,  7, 12,  7,  4, -1] },
  { chord: D,  tune: [ 0,  2,  4, -1,  7, -1,  4,  2] },
  { chord: Em, tune: [ 2, -1,  5,  9, 14,  9,  5, -1] },
  { chord: Em, tune: [14, 12,  9, -1,  5,  9, 12, 14] },
  { chord: A,  tune: [16, -1, 14, 11,  7, 11, 14, 16] },
  { chord: A,  tune: [19, 16, 14, 11, 14, -1, -1, -1] },
];
const MUSIC_VOLUME = 0.5;
const MUSIC_KEY = 'dino-kart-music';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'off';
  } catch {
    return true;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // Storage unavailable (private window): the setting just won't be remembered.
  }
}

class Sound {
  enabled = readFlag(STORAGE_KEY);
  musicOn = readFlag(MUSIC_KEY);
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly samples = new Map<Effect, AudioBuffer>();

  /** One looping sound per surface, each with its own volume so they can cross-fade. */
  private readonly surfaces = new Map<SurfaceSound, { source: AudioBufferSourceNode; gain: GainNode }>();

  // The engine is a looping recording if there is one, otherwise an oscillator.
  private engineGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineLoop: AudioBufferSourceNode | null = null;

  private musicTimer: number | undefined;
  private nextStep = 0;
  private nextStepTime = 0;

  /** Browsers only allow sound after a tap; call this from a button press. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 1 : 0;
      // Everything passes through a gentle compressor, so that when a lot is
      // going on at once (engine, music, water, a boost and a voice line) the
      // loud moments are pulled down instead of distorting.
      const glue = this.ctx.createDynamicsCompressor();
      glue.threshold.value = -16;
      glue.knee.value = 12;
      glue.ratio.value = 3.5;
      glue.attack.value = 0.01;
      glue.release.value = 0.25;
      this.master.connect(glue).connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicOn ? MUSIC_VOLUME : 0;
      this.musicBus.connect(this.master);
      // One second of white noise, for the percussion.
      this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const samples = this.noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineGain.connect(this.master);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;
      this.engineOsc = this.ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineOsc.connect(filter).connect(this.engineGain);
      this.engineOsc.start();

      void this.loadSamples();
    }
    void this.ctx.resume();
  }

  private async loadSamples(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    let manifest: Record<string, unknown>;
    try {
      const res = await fetch(`${SFX}manifest.json`);
      if (!res.ok) return;
      manifest = (await res.json()) as Record<string, unknown>;
    } catch {
      return; // No recordings: everything stays synthesised.
    }
    await Promise.all(
      Object.keys(manifest).map(async (id) => {
        try {
          const data = await (await fetch(`${SFX}${id}.mp3`)).arrayBuffer();
          this.samples.set(id as Effect, await ctx.decodeAudioData(data));
        } catch {
          // This one effect keeps its synthesised fallback.
        }
      }),
    );

    // Start every surface loop silent; `surface` fades the right one in.
    for (const [kind, id] of Object.entries(SURFACE_LOOPS) as [SurfaceSound, SurfaceLoop][]) {
      const buffer = this.samples.get(id);
      if (!buffer || !this.master) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.master);
      source.start();
      this.surfaces.set(kind, { source, gain });
    }

    // Swap the oscillator engine for the recorded loop.
    const engine = this.samples.get('engine');
    if (engine && this.engineGain) {
      this.engineOsc?.stop();
      this.engineOsc = null;
      this.engineLoop = ctx.createBufferSource();
      this.engineLoop.buffer = engine;
      this.engineLoop.loop = true;
      this.engineLoop.connect(this.engineGain);
      this.engineLoop.start();
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    writeFlag(STORAGE_KEY, on);
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Turn just the background music on or off. */
  setMusic(on: boolean): void {
    this.musicOn = on;
    writeFlag(MUSIC_KEY, on);
    if (this.ctx && this.musicBus) {
      this.musicBus.gain.setTargetAtTime(on ? MUSIC_VOLUME : 0, this.ctx.currentTime, 0.1);
    }
  }

  /** Silence everything while paused or in the background. */
  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  /** Engine sound. `speed` is 0..1 of top speed (can go above 1 when boosting); 0 volume = off. */
  engine(speed: number, volume: number): void {
    if (!this.ctx || !this.engineGain) return;
    const t = this.ctx.currentTime;
    if (this.engineLoop) {
      // Faster = higher pitched, by playing the loop faster.
      this.engineLoop.playbackRate.setTargetAtTime(0.7 + 0.75 * speed, t, 0.08);
      this.engineGain.gain.setTargetAtTime(VOLUME.engine * volume, t, 0.08);
    } else if (this.engineOsc) {
      this.engineOsc.frequency.setTargetAtTime(55 + 95 * speed, t, 0.08);
      this.engineGain.gain.setTargetAtTime(0.05 * volume, t, 0.08);
    }
  }

  /**
   * The sound of the wheels on whatever the player is driving over. `kind` is
   * null when the kart is in the air or stopped. `speed` is 0..1 of top speed:
   * a faster kart is louder and slightly higher pitched.
   */
  surface(kind: SurfaceSound | null, speed: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const amount = Math.max(0, Math.min(1.2, speed));
    for (const [name, loop] of this.surfaces) {
      const level = name === kind ? VOLUME[SURFACE_LOOPS[name]] * Math.min(1, amount * 1.3) : 0;
      // Cross-fade over about a fifth of a second so changes of surface are smooth, not a cut.
      loop.gain.gain.setTargetAtTime(level, t, 0.07);
      loop.source.playbackRate.setTargetAtTime(0.85 + 0.3 * amount, t, 0.1);
    }
  }

  /** Play a recorded effect. Returns false if there is no recording, so the caller can synthesise it. */
  private sample(id: Effect): boolean {
    const buffer = this.samples.get(id);
    if (!buffer || !this.ctx || !this.master) return false;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = VOLUME[id];
    source.connect(gain).connect(this.master);
    source.start();
    return true;
  }

  private tone(
    freq: number,
    duration: number,
    type: OscillatorType = 'square',
    volume = 0.12,
    delay = 0,
    slideTo?: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  tap(): void {
    if (!this.sample('tap')) this.tone(660, 0.08, 'square', 0.1);
  }
  countdown(): void {
    if (!this.sample('countdown')) this.tone(440, 0.18, 'square', 0.14);
  }
  go(): void {
    if (!this.sample('go')) this.tone(880, 0.45, 'square', 0.14);
  }
  pickup(): void {
    if (this.sample('pickup')) return;
    for (let i = 0; i < 6; i++) this.tone(700 + (i % 3) * 180, 0.07, 'square', 0.08, i * 0.09);
  }
  gotItem(): void {
    if (this.sample('gotItem')) return;
    this.tone(784, 0.1, 'square', 0.12);
    this.tone(1047, 0.2, 'square', 0.12, 0.1);
  }
  drop(): void {
    if (!this.sample('drop')) this.tone(300, 0.15, 'triangle', 0.18, 0, 150);
  }
  boost(): void {
    if (!this.sample('boost')) this.tone(220, 0.6, 'sawtooth', 0.1, 0, 900);
  }
  throwEgg(): void {
    if (!this.sample('throwEgg')) this.tone(500, 0.25, 'triangle', 0.16, 0, 1000);
  }
  tar(): void {
    if (!this.sample('tar')) this.tone(180, 0.25, 'triangle', 0.18, 0, 90);
  }
  stuck(): void {
    if (!this.sample('stuck')) this.tone(140, 0.4, 'sawtooth', 0.1, 0, 70);
  }
  ptero(): void {
    if (!this.sample('ptero')) this.tone(900, 0.5, 'sawtooth', 0.1, 0, 1600);
  }
  splash(): void {
    if (!this.sample('splash')) this.tone(500, 0.45, 'triangle', 0.14, 0, 120);
  }
  hit(): void {
    if (!this.sample('hit')) this.tone(700, 0.5, 'sawtooth', 0.12, 0, 120);
  }
  lap(): void {
    if (this.sample('lap')) return;
    this.tone(784, 0.1, 'square', 0.12);
    this.tone(988, 0.1, 'square', 0.12, 0.1);
    this.tone(1175, 0.22, 'square', 0.12, 0.2);
  }
  finish(): void {
    if (this.sample('finish')) return;
    [0, 4, 7, 12, 7, 12, 16].forEach((n, i) => this.tone(note(n + 12), 0.2, 'square', 0.13, i * 0.13));
  }

  /** One soft mallet note: quick attack, then it rings away. */
  private pluck(freq: number, t: number, volume: number, duration: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx || !this.musicBus) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** A soft thump on the beat. */
  private kick(t: number): void {
    if (!this.ctx || !this.musicBus) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    gain.gain.setValueAtTime(0.32, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** A short shaker tick. */
  private shaker(t: number, volume: number): void {
    if (!this.ctx || !this.musicBus || !this.noise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6000;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(filter).connect(gain).connect(this.musicBus);
    src.start(t, Math.random() * 0.5, 0.06);
  }

  private scheduleStep(step: number, t: number): void {
    const bar = BARS[Math.floor(step / 8) % BARS.length];
    const beat = step % 8;
    const n = bar.tune[beat];
    if (n >= 0) {
      // Marimba: a sine body with a quiet octave "tick" on top.
      this.pluck(note(n), t, 0.2, 0.5);
      this.pluck(note(n + 12), t, 0.05, 0.14, 'triangle');
    }
    // Bass: root on beats 1 and 3, fifth on the "and" before each.
    if (beat === 0 || beat === 4) this.pluck(note(bar.chord[0] - 24), t, 0.26, 0.5, 'triangle');
    if (beat === 3 || beat === 7) this.pluck(note(bar.chord[2] - 24), t, 0.14, 0.3, 'triangle');
    // Off-beat chord stabs give it the bounce.
    if (beat % 2 === 1) for (const c of bar.chord) this.pluck(note(c - 12), t, 0.04, 0.18, 'triangle');
    if (beat === 0 || beat === 4) this.kick(t);
    this.shaker(t, beat % 2 === 1 ? 0.07 : 0.03);
  }

  startMusic(): void {
    if (!this.ctx || this.musicTimer !== undefined) return;
    this.nextStep = 0;
    this.nextStepTime = this.ctx.currentTime + 0.1;
    // Schedule a little ahead of the clock so timing stays tight.
    this.musicTimer = window.setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      // If the clock ran on without us (tab in the background), don't play catch-up.
      if (this.nextStepTime < this.ctx.currentTime) this.nextStepTime = this.ctx.currentTime + 0.05;
      while (this.nextStepTime < this.ctx.currentTime + 0.3) {
        this.scheduleStep(this.nextStep, this.nextStepTime);
        this.nextStep++;
        this.nextStepTime += STEP;
      }
    }, 100);
  }

  stopMusic(): void {
    window.clearInterval(this.musicTimer);
    this.musicTimer = undefined;
  }
}

export const sound = new Sound();
