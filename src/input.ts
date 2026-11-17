/**
 * Steering input. Touch the left half of the screen to steer left, the right
 * half to steer right. Arrow keys / A and D do the same on a keyboard.
 */
export class Input {
  private pointers = new Map<number, -1 | 1>();
  private keys = new Set<string>();

  constructor(target: HTMLElement) {
    const side = (e: PointerEvent): -1 | 1 => (e.clientX < window.innerWidth / 2 ? -1 : 1);

    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.pointers.set(e.pointerId, side(e));
    });
    target.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, side(e));
    });
    const release = (e: PointerEvent) => this.pointers.delete(e.pointerId);
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', release);
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.pointers.clear();
      this.keys.clear();
    });
  }

  /** -1 = left, 0 = straight, 1 = right. Both sides held cancels out. */
  get steer(): number {
    let left = this.keys.has('arrowleft') || this.keys.has('a');
    let right = this.keys.has('arrowright') || this.keys.has('d');
    for (const s of this.pointers.values()) {
      if (s < 0) left = true;
      else right = true;
    }
    return (right ? 1 : 0) - (left ? 1 : 0);
  }
}
