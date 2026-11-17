// Generates the game's sound effects with ElevenLabs, a few takes of each so the best can be chosen.
//
//   npm run sfx                     generate takes for any effect that is new or whose prompt changed, then publish
//   npm run sfx -- --retake hit     throw away the takes of one or more effects and generate fresh ones
//   npm run sfx -- --dry            just list what would be generated
//
// Effects are listed in scripts/sfx.json: a prompt, a length in seconds, and `pick`, the take to use.
// Takes are written to art/sfx/<id>-<n>.mp3 for auditioning (local only). The picked take of each
// effect is copied to public/audio/sfx/<id>.mp3 and listed in manifest.json; the game plays the
// effects in the manifest and falls back to its built-in synthesised sound for any that are missing.
// To switch takes: listen, change `pick` in sfx.json, run `npm run sfx` again (no new generation).
// Once an effect is settled its other takes can be deleted: an effect whose picked take is there
// is left alone, so they are not generated again.
// Reads ELEVENLABS_API_KEY from .env.local.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAKES = 3;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const takesDir = join(root, 'art/sfx');
const outDir = join(root, 'public/audio/sfx');
const statePath = join(takesDir, 'takes.json');
const effects = JSON.parse(readFileSync(join(here, 'sfx.json'), 'utf8'));

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const retakeAt = args.indexOf('--retake');
const retake = retakeAt >= 0 ? args.slice(retakeAt + 1).filter((a) => !a.startsWith('--')) : [];
for (const id of retake) if (!effects[id]) throw new Error(`unknown effect "${id}"`);

const key = process.env.ELEVENLABS_API_KEY;
if (!dry && !key) {
  console.error('Missing ELEVENLABS_API_KEY. Add it to .env.local first.');
  process.exit(1);
}

mkdirSync(takesDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
// Remembers which prompt each take was made from, so edited prompts are regenerated.
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const hash = (fx) =>
  createHash('sha1').update(`${fx.prompt}|${fx.seconds}|${fx.loop ?? false}`).digest('hex').slice(0, 12);

let made = 0;
for (const [id, fx] of Object.entries(effects)) {
  const h = hash(fx);
  const have = (n) => state[`${id}-${n}`] === h && existsSync(join(takesDir, `${id}-${n}.mp3`));
  // The chosen take is there and up to date: the others are not needed.
  if (!retake.includes(id) && have(fx.pick)) continue;
  for (let n = 1; n <= TAKES; n++) {
    const takeId = `${id}-${n}`;
    const file = join(takesDir, `${takeId}.mp3`);
    if (!retake.includes(id) && have(n)) continue;
    if (dry) {
      console.log(`would generate ${takeId} (${fx.seconds}s): "${fx.prompt}"`);
      continue;
    }
    process.stdout.write(`${takeId} … `);
    const res = await fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: fx.prompt,
        duration_seconds: fx.seconds,
        prompt_influence: 0.5,
        ...(fx.loop ? { loop: true } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      process.exit(1);
    }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    state[takeId] = h;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    made++;
    console.log('ok');
  }
}

if (!dry) {
  // Publish the picked take of each effect, and drop published files for effects that no longer exist.
  const manifest = {};
  for (const [id, fx] of Object.entries(effects)) {
    const pick = join(takesDir, `${id}-${fx.pick}.mp3`);
    if (!existsSync(pick)) {
      console.warn(`${id}: take ${fx.pick} does not exist, not published`);
      continue;
    }
    copyFileSync(pick, join(outDir, `${id}.mp3`));
    manifest[id] = { take: fx.pick, loop: fx.loop ?? false };
  }
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.mp3') && !(f.slice(0, -4) in manifest)) unlinkSync(join(outDir, f));
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Done: ${made} take(s) generated, ${Object.keys(manifest).length} effect(s) published.`);
}
