// Publishes the game's music: "theme" for the menus, and one piece per track, named by the track's id.
//
//   npm run music                      publish every piece (generating any takes that are needed first)
//   npm run music -- --retake theme    throw away the generated takes of one or more pieces and make fresh ones
//   npm run music -- --dry             just list what would be generated
//
// Pieces are listed in scripts/music.json. Each is either
//   { "file": "Some_Tune.mp3" }                  a finished recording in art/music/, used as it is, or
//   { "prompt": "...", "seconds": 60, "pick": 1 } generated with ElevenLabs Music: a few takes are written
//                                                 to art/music/<id>-<n>.mp3 and `pick` chooses the one to use.
// The chosen recording of each piece is copied to public/audio/music/<id>.mp3 and listed in
// manifest.json; the game plays what is in the manifest. art/music/ is local only.
//
// A piece can also have "loop": { "start": 13.13, "bpm": 110, "bars": 20, "fade": 2.18 } to be rebuilt
// as a seamless loop of that many bars beginning at `start` seconds: see makeLoop below. Needs ffmpeg.
// Reads ELEVENLABS_API_KEY from .env.local.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAKES = 3;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const takesDir = join(root, 'art/music');
const outDir = join(root, 'public/audio/music');
const statePath = join(takesDir, 'takes.json');
const pieces = JSON.parse(readFileSync(join(here, 'music.json'), 'utf8'));

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const retakeAt = args.indexOf('--retake');
const retake = retakeAt >= 0 ? args.slice(retakeAt + 1).filter((a) => !a.startsWith('--')) : [];
for (const id of retake) if (!pieces[id]) throw new Error(`unknown piece "${id}"`);

const key = process.env.ELEVENLABS_API_KEY;
if (!dry && !key) {
  console.error('Missing ELEVENLABS_API_KEY. Add it to .env.local first.');
  process.exit(1);
}

mkdirSync(takesDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
// Remembers which prompt each take was made from, so edited prompts are regenerated.
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const hash = (piece) => createHash('sha1').update(`${piece.prompt}|${piece.seconds}`).digest('hex').slice(0, 12);

/**
 * Rebuild a recording as a seamless loop, skipping its opening.
 *
 * `loop` gives where the loop starts (seconds, on a bar line), the tempo, and
 * how many bars it lasts, so both ends fall on the beat. Over the last `fade`
 * seconds the music cross-fades into what came just BEFORE the start point, so
 * when the loop jumps back the sound carries straight on, in time.
 *
 * The file written holds the loop plus half a second of the same music before
 * and after it. The game loops the middle part by its exact length, which
 * keeps the join perfect whatever silence the MP3 format adds at the ends.
 * Returns { start, length } in seconds, for the manifest.
 */
function makeLoop(source, target, { start, bpm, bars, fade }) {
  const PAD = 0.5;
  // Begin a hair before the bar line so the first note's attack is not clipped.
  const s = start - 0.02;
  const length = (bars * 4 * 60) / bpm;
  const e = s + length;
  const duration = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source]),
  );
  if (s - fade < 0 || e > duration) {
    throw new Error(`loop ${s.toFixed(2)}s-${e.toFixed(2)}s (with a ${fade}s fade) does not fit in ${duration.toFixed(2)}s`);
  }

  const f = (n) => n.toFixed(4);
  const cut = (from, to, name) => `[0]atrim=start=${f(from)}:end=${f(to)},asetpts=N/SR/TB[${name}]`;
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-i', source,
      '-filter_complex',
      [
        cut(s, e - fade, 'body'),
        cut(e - fade, e, 'out'), // the end of the loop, fading out...
        cut(s - fade, s, 'in'), // ...into the run-up to its start, fading in
        `[out][in]acrossfade=d=${f(fade)}:c1=qsin:c2=qsin[join]`,
        '[body][join]concat=n=2:v=0:a=1,asplit=3[l1][l2][l3]',
        // Half a second of the loop's own end before it, and of its start after it.
        `[l1]atrim=start=${f(length - PAD)},asetpts=N/SR/TB[lead]`,
        `[l3]atrim=end=${f(PAD)},asetpts=N/SR/TB[tail]`,
        '[lead][l2][tail]concat=n=3:v=0:a=1[final]',
      ].join(';'),
      '-map', '[final]', '-c:a', 'libmp3lame', '-b:a', '192k', target,
    ],
    { stdio: 'inherit' },
  );
  console.log(`loop: ${s.toFixed(2)}s to ${e.toFixed(2)}s of ${duration.toFixed(2)}s (${bars} bars at ${bpm} bpm)`);
  return { start: PAD, length: Number(length.toFixed(4)) };
}

let made = 0;
for (const [id, piece] of Object.entries(pieces)) {
  if (piece.file) continue; // a supplied recording: nothing to generate
  const h = hash(piece);
  for (let n = 1; n <= TAKES; n++) {
    const takeId = `${id}-${n}`;
    const file = join(takesDir, `${takeId}.mp3`);
    if (!retake.includes(id) && state[takeId] === h && existsSync(file)) continue;
    if (dry) {
      console.log(`would generate ${takeId} (${piece.seconds}s)`);
      continue;
    }
    process.stdout.write(`${takeId} … `);
    const res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ prompt: piece.prompt, music_length_ms: piece.seconds * 1000, force_instrumental: true }),
    });
    if (!res.ok) {
      console.error(`failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
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
  // Publish the picked take of each piece, and drop published files for pieces that no longer exist.
  const manifest = {};
  for (const [id, piece] of Object.entries(pieces)) {
    const pick = join(takesDir, piece.file ?? `${id}-${piece.pick}.mp3`);
    if (!existsSync(pick)) {
      console.warn(`${id}: ${piece.file ?? `take ${piece.pick}`} does not exist in art/music, not published`);
      continue;
    }
    manifest[id] = piece.file ? { file: piece.file } : { take: piece.pick };
    if (piece.loop) manifest[id].loop = makeLoop(pick, join(outDir, `${id}.mp3`), piece.loop);
    else copyFileSync(pick, join(outDir, `${id}.mp3`));
  }
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.mp3') && !(f.slice(0, -4) in manifest)) unlinkSync(join(outDir, f));
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Done: ${made} take(s) generated, ${Object.keys(manifest).length} piece(s) published.`);
}
