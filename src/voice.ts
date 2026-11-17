import { sound } from './audio';
import LINES from './voice-lines.json';

/**
 * Spoken lines. Each line in voice-lines.json plays its recorded clip from
 * public/audio/voice/ if `npm run voices` has made one; otherwise the device's
 * own speech voice reads it, so the game talks even before any clips exist.
 */
export type VoiceLine = keyof typeof LINES;

const BASE = `${import.meta.env.BASE_URL}audio/voice/`;

/** ids of the clips that exist (written by `npm run voices`) */
let recorded = new Set<string>();
fetch(`${BASE}manifest.json`)
  .then((res) => (res.ok ? res.json() : {}))
  .then((manifest: Record<string, string>) => {
    recorded = new Set(Object.keys(manifest));
  })
  .catch(() => {
    // No clips yet: every line falls back to the device voice.
  });

let deviceVoice: SpeechSynthesisVoice | null = null;
/** Prefer a natural-sounding English voice over the novelty ones some devices ship. */
function pickDeviceVoice(): void {
  const voices = speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
  const score = (v: SpeechSynthesisVoice) =>
    (/samantha|karen|daniel|moira|serena|google (uk|us) english/i.test(v.name) ? 4 : 0) +
    (/enhanced|premium|natural/i.test(v.name) ? 2 : 0) +
    (v.localService ? 1 : 0);
  voices.sort((a, b) => score(b) - score(a));
  deviceVoice = voices[0] ?? null;
}
if ('speechSynthesis' in window) {
  pickDeviceVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickDeviceVoice);
}

let clip: HTMLAudioElement | null = null;

export const voice = {
  /** Say a line, cutting off whatever was being said before. Silent when sound is off. */
  say(id: VoiceLine): void {
    this.stop();
    if (!sound.enabled) return;
    if (recorded.has(id)) {
      clip = new Audio(`${BASE}${id}.mp3`);
      void clip.play().catch(() => {
        // Playback refused (no tap yet): stay silent.
      });
    } else if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(LINES[id]);
      if (deviceVoice) {
        utterance.voice = deviceVoice;
        utterance.lang = deviceVoice.lang;
      }
      utterance.pitch = 1.2;
      speechSynthesis.speak(utterance);
    }
  },

  stop(): void {
    clip?.pause();
    clip = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  },
};
