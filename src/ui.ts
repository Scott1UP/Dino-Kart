/**
 * Everything drawn in HTML on top of the game: the title screen, character
 * select, the in-race display, the pause menu and the finish panel.
 */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SPRITES = `${import.meta.env.BASE_URL}sprites/`;

export type Screen = 'title' | 'select' | 'tracks' | 'race' | 'pause' | 'settings' | 'controls' | 'finish';

const screens: Record<Exclude<Screen, 'race'>, HTMLElement> = {
  title: el('title'),
  select: el('select'),
  tracks: el('tracks'),
  pause: el('pause'),
  settings: el('settings'),
  controls: el('controls'),
  finish: el('finish'),
};
const hud = el('hud');

const lap = el('lap');
const place = el('place');
const placeSuffix = el('place-suffix');
const banner = el('banner');
const item = el('item');
const itemIcon = el('item-icon');
const fire = el<HTMLButtonElement>('fire');
const fireIcon = el('fire-icon');
const musicButton = el<HTMLButtonElement>('music');
const retroButton = el<HTMLButtonElement>('retro');
const speedButtons = [...el('speed').querySelectorAll<HTMLButtonElement>('button')];
const placeTotal = el('place-total');
const finishTitle = el('finish-title');
const standings = el('standings');
const confetti = el('confetti');
const soundButton = el<HTMLButtonElement>('sound');
const racerList = el('racers');
const trackList = el('track-list');
const pickTitle = el('pick-title');
const go = el<HTMLButtonElement>('go');
const trackTitle = el('track-title');
const goTrack = el<HTMLButtonElement>('go-track');
itemIcon.style.backgroundImage = `url(${SPRITES}items.png)`;
fireIcon.style.backgroundImage = `url(${SPRITES}items.png)`;

const SUFFIX = ['st', 'nd', 'rd'];
const suffix = (n: number) => SUFFIX[n - 1] ?? 'th';
const CONFETTI_COLORS = ['#ff5e7e', '#ffc21f', '#6fd03c', '#3bb4f6', '#b58cff'];

export interface TrackChoice {
  id: string;
  name: string;
}

export interface RacerChoice {
  id: string;
  name: string;
  /** How the frames are laid out on the racer's sprite sheet, and which one to show. */
  cols: number;
  rows: number;
  portraitFrame: number;
}

let racers: RacerChoice[] = [];
let selected: string | null = null;
let tracks: TrackChoice[] = [];
let selectedTrack: string | null = null;
let lastLap = '';
let lastPlace = 0;
let lastBanner = '';
let lastItem = -2;
let lastReady = false;

/** Show one frame of a racer's sprite sheet as the background of an element. */
function showPortrait(node: HTMLElement, racer: RacerChoice): void {
  node.style.backgroundImage = `url(${SPRITES}${racer.id}.png)`;
  const col = racer.portraitFrame % racer.cols;
  const row = Math.floor(racer.portraitFrame / racer.cols);
  node.style.backgroundSize = `${racer.cols * 100}% ${racer.rows * 100}%`;
  node.style.backgroundPosition =
    `${(col / Math.max(1, racer.cols - 1)) * 100}% ${(row / Math.max(1, racer.rows - 1)) * 100}%`;
}

function select(id: string | null): void {
  selected = id;
  for (const card of racerList.querySelectorAll<HTMLElement>('.racer')) {
    card.classList.toggle('selected', card.dataset.id === id);
    card.classList.toggle('dim', id !== null && card.dataset.id !== id);
    card.setAttribute('aria-pressed', String(card.dataset.id === id));
  }
  go.classList.toggle('show', id !== null);
  const racer = racers.find((r) => r.id === id);
  pickTitle.textContent = racer ? `${racer.name}!` : 'Pick your dino!';
}

function selectTrack(id: string | null): void {
  selectedTrack = id;
  for (const card of trackList.querySelectorAll<HTMLElement>('.track-card')) {
    card.classList.toggle('selected', card.dataset.id === id);
    card.classList.toggle('dim', id !== null && card.dataset.id !== id);
    card.setAttribute('aria-pressed', String(card.dataset.id === id));
  }
  goTrack.classList.toggle('show', id !== null);
  const track = tracks.find((t) => t.id === id);
  trackTitle.textContent = track ? `${track.name}!` : 'Pick a track!';
}

export const ui = {
  /** Show one screen. 'race' shows just the in-race display; pause and finish sit on top of it. */
  show(screen: Screen): void {
    if (screen === 'select') select(null);
    if (screen === 'tracks') selectTrack(null);
    for (const [name, node] of Object.entries(screens)) node.classList.toggle('hidden', name !== screen);
    hud.classList.toggle('hidden', screen === 'title' || screen === 'select' || screen === 'tracks');
  },

  /**
   * Build the character select cards. The first tap on a card selects that
   * racer (`onSelect`); tapping it again, or the Go button, confirms (`onPick`).
   */
  setRacers(list: RacerChoice[], onSelect: (id: string) => void, onPick: (id: string) => void): void {
    racers = list;
    racerList.replaceChildren(
      ...list.map((racer) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'racer';
        card.dataset.id = racer.id;
        const portrait = document.createElement('span');
        portrait.className = 'portrait';
        const picture = document.createElement('i');
        showPortrait(picture, racer);
        portrait.append(picture);
        const name = document.createElement('span');
        name.className = 'racer-name';
        name.textContent = racer.name;
        card.append(portrait, name);
        card.addEventListener('click', () => {
          if (selected === racer.id) return onPick(racer.id);
          select(racer.id);
          onSelect(racer.id);
        });
        return card;
      }),
    );
    go.addEventListener('click', () => {
      if (selected) onPick(selected);
    });
  },

  /**
   * Build the track select cards, each with a picture taken on that track
   * (public/covers/<id>.jpg, made by `npm run capture`). As with the racers,
   * the first tap on a card selects that track (`onSelect`); tapping it
   * again, or the Go button, confirms (`onPick`).
   */
  setTracks(list: TrackChoice[], onSelect: (id: string) => void, onPick: (id: string) => void): void {
    tracks = list;
    trackList.replaceChildren(
      ...list.map((track) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'track-card';
        card.dataset.id = track.id;
        const cover = document.createElement('img');
        cover.src = `${import.meta.env.BASE_URL}covers/${track.id}.jpg`;
        cover.alt = '';
        cover.width = 640;
        cover.height = 400;
        cover.draggable = false;
        const name = document.createElement('span');
        name.className = 'track-name';
        name.textContent = track.name;
        card.append(cover, name);
        card.addEventListener('click', () => {
          if (selectedTrack === track.id) return onPick(track.id);
          selectTrack(track.id);
          onSelect(track.id);
        });
        return card;
      }),
    );
    goTrack.addEventListener('click', () => {
      if (selectedTrack) onPick(selectedTrack);
    });
  },

  /** Wire up a button by its `data-action` name, e.g. on('play', ...). */
  on(action: string, handler: () => void): void {
    for (const button of document.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)) {
      button.addEventListener('click', handler);
    }
  },

  setSound(on: boolean): void {
    const icon = document.createElement('span');
    icon.className = 'emoji';
    icon.textContent = on ? '🔊' : '🔇';
    soundButton.replaceChildren(icon, on ? ' Sound on' : ' Sound off');
    soundButton.setAttribute('aria-pressed', String(on));
  },

  setMusic(on: boolean): void {
    const icon = document.createElement('span');
    icon.className = 'emoji';
    icon.textContent = '🎵';
    musicButton.replaceChildren(icon, on ? ' Music on' : ' Music off');
    musicButton.setAttribute('aria-pressed', String(on));
  },

  /** Light up the chosen speed class (125, 150 or 200) on the character select screen. */
  setSpeedClass(cc: number): void {
    for (const button of speedButtons) button.setAttribute('aria-pressed', String(Number(button.dataset.cc) === cc));
  },

  onSpeedClass(handler: (cc: number) => void): void {
    for (const button of speedButtons) button.addEventListener('click', () => handler(Number(button.dataset.cc)));
  },

  setRetro(on: boolean): void {
    const icon = document.createElement('span');
    icon.className = 'emoji';
    icon.textContent = '📺';
    retroButton.replaceChildren(icon, on ? ' Retro look on' : ' Retro look off');
    retroButton.setAttribute('aria-pressed', String(on));
  },

  /** The big item button was pressed. Fires on touch-down so it feels instant. */
  onFire(handler: () => void): void {
    fire.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handler();
    });
  },

  setLap(current: number, total: number): void {
    const text = `${current}/${total}`;
    if (text === lastLap) return;
    lastLap = text;
    lap.textContent = text;
  },

  /** The player's position out of the number of racers, shown as e.g. "2nd/6". */
  setPlace(n: number, total: number): void {
    if (n === lastPlace) return;
    lastPlace = n;
    place.textContent = String(n);
    placeSuffix.textContent = suffix(n);
    placeTotal.textContent = `/${total}`;
  },

  /** Big centre text ("3", "2", "1", "GO!"); empty string hides it. */
  setBanner(text: string): void {
    if (text === lastBanner) return;
    lastBanner = text;
    // A fresh element each time so the pop-in animation replays.
    const span = document.createElement('span');
    span.textContent = text;
    banner.replaceChildren(span);
    banner.classList.toggle('hidden', text === '');
  },

  /**
   * Show one object from the items sheet in the item slot and on the fire
   * button. `name` is the item (null empties both) and `index` its position
   * on the sheet out of `count`. `ready` lights up the fire button: the item
   * is held and can be used now.
   */
  setItem(name: string | null, index: number, count: number, ready: boolean): void {
    if (ready !== lastReady) {
      lastReady = ready;
      fire.classList.toggle('ready', ready);
      fire.disabled = !ready;
    }
    if (index === lastItem) return;
    lastItem = index;
    item.classList.toggle('empty', index < 0);
    // The button takes its colour from the item it holds (see style.css).
    fire.dataset.item = name ?? '';
    if (index >= 0) {
      for (const icon of [itemIcon, fireIcon]) {
        icon.style.backgroundSize = `${count * 100}% 100%`;
        icon.style.backgroundPosition = `${(index / (count - 1)) * 100}% 0`;
      }
    }
  },

  /**
   * Fill in the finish panel: every racer in finishing order (first place
   * first), with the player's own row highlighted.
   */
  setFinish(order: string[], playerId: string): void {
    const n = order.indexOf(playerId) + 1;
    finishTitle.textContent = `You came ${n}${suffix(n)}!`;
    standings.replaceChildren(
      ...order.map((id, i) => {
        const row = document.createElement('li');
        row.className = id === playerId ? 'standing me' : 'standing';
        row.style.setProperty('--i', String(i));
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = String(i + 1);
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        const img = document.createElement('img');
        img.src = `${SPRITES}avatar-${id}.png`;
        img.alt = '';
        avatar.append(img);
        const name = document.createElement('span');
        name.textContent = racers.find((r) => r.id === id)?.name ?? id;
        row.append(pos, avatar, name);
        return row;
      }),
    );
    confetti.replaceChildren(
      ...Array.from({ length: 36 }, (_, i) => {
        const bit = document.createElement('i');
        const size = 8 + Math.random() * 10;
        bit.style.left = `${Math.random() * 100}%`;
        bit.style.width = `${size}px`;
        bit.style.height = `${size * 1.6}px`;
        bit.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        bit.style.animationDuration = `${2.5 + Math.random() * 2.5}s`;
        bit.style.animationDelay = `${-Math.random() * 5}s`;
        return bit;
      }),
    );
  },
};
