// Generates the game's voice-over clips with ElevenLabs.
//
//   npm run voices            generate any clip that is missing or whose text changed
//   npm run voices -- --all   regenerate everything (e.g. after choosing a different voice)
//   npm run voices -- --dry   just list what would be generated
//
// Reads ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID from .env.local. Lines live in src/voice-lines.json.
// The voice is used exactly as it is saved in ElevenLabs: no voice settings are sent, so its own saved
// stability / similarity / style apply. (Overriding them made a British voice drift American.)
// A model is only sent if ELEVENLABS_MODEL_ID is set; otherwise ElevenLabs picks its default.
// Output: public/audio/voice/<id>.mp3 + manifest.json (the game only plays clips listed in the manifest).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/audio/voice');
const manifestPath = join(outDir, 'manifest.json');
const lines = JSON.parse(readFileSync(join(root, 'src/voice-lines.json'), 'utf8'));
const all = process.argv.includes('--all');
const dry = process.argv.includes('--dry');

const key = process.env.ELEVENLABS_API_KEY;
const voice = process.env.ELEVENLABS_VOICE_ID;
const model = process.env.ELEVENLABS_MODEL_ID || '';
if (!dry && (!key || !voice)) {
  console.error('Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID. Fill them in in .env.local first.');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const hash = (text) => createHash('sha1').update(`${voice}|${model}|as-saved|${text}`).digest('hex').slice(0, 12);

let made = 0, chars = 0;
for (const [id, text] of Object.entries(lines)) {
  const h = hash(text);
  const file = join(outDir, `${id}.mp3`);
  if (!all && manifest[id] === h && existsSync(file)) continue;
  chars += text.length;
  if (dry) {
    console.log(`would generate ${id}: "${text}"`);
    continue;
  }
  process.stdout.write(`${id} … `);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(model ? { text, model_id: model } : { text }),
  });
  if (!res.ok) {
    console.error(`failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  manifest[id] = h;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  made++;
  console.log('ok');
}
// drop manifest entries and delete clips for lines that no longer exist
for (const id of Object.keys(manifest)) if (!(id in lines)) delete manifest[id];
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.mp3') && !(f.slice(0, -4) in lines)) {
    console.log(`${dry ? 'would delete' : 'deleting'} unused clip ${f}`);
    if (!dry) unlinkSync(join(outDir, f));
  }
}
if (!dry) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(dry ? `${chars} characters to generate.` : `Done: ${made} clip(s) generated (${chars} characters).`);
