import * as THREE from 'three';

export const SKY_TOP = '#2f7fe0';
/** Colour of the sky at the horizon; also used for distance haze. */
export const HAZE = '#c9ecf7';

const RADIUS = 3000;
const HEIGHT = 900;
/** How far the bottom edge sits below the ground, so no gap ever shows. */
const SINK = 40;

/**
 * The backdrop: a sky gradient with distant jungle hills and a volcano,
 * wrapped around a big cylinder. Call `follow` each frame so it stays centred
 * on the camera and only ever appears to rotate.
 */
export function makeSky(): { mesh: THREE.Mesh; follow: (camera: THREE.Camera) => void } {
  const w = 1024;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, SKY_TOP);
  sky.addColorStop(0.7, HAZE);
  sky.addColorStop(1, HAZE);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Volcano, drawn twice so it also wraps cleanly across the seam.
  const volcano = (cx: number) => {
    ctx.fillStyle = '#8d93b8';
    ctx.beginPath();
    ctx.moveTo(cx - 150, h);
    ctx.lineTo(cx - 28, h - 118);
    ctx.lineTo(cx + 28, h - 118);
    ctx.lineTo(cx + 150, h);
    ctx.fill();
    ctx.fillStyle = '#f08a4b';
    ctx.fillRect(cx - 28, h - 118, 56, 7);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    for (const [dx, dy, r] of [
      [0, -134, 16],
      [18, -152, 20],
      [44, -168, 15],
    ]) {
      ctx.beginPath();
      ctx.arc(cx + dx, h + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  volcano(300);

  // Rolling hills; heights are sums of sines that repeat exactly over the width.
  const hills = (color: string, base: number, amp: number, k1: number, k2: number, phase: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const t = (x / w) * Math.PI * 2;
      const y = base + amp * (Math.sin(t * k1 + phase) * 0.6 + Math.sin(t * k2 + phase * 2) * 0.4);
      ctx.lineTo(x, h - y);
    }
    ctx.lineTo(w, h);
    ctx.fill();
  };
  hills('#7fb6c9', 62, 22, 3, 7, 0.5);
  hills('#58a878', 40, 14, 5, 11, 2.1);
  hills('#3f9650', 22, 8, 8, 17, 4.0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(RADIUS, RADIUS, HEIGHT, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  mesh.renderOrder = -1;

  return {
    mesh,
    follow(camera) {
      mesh.position.set(camera.position.x, HEIGHT / 2 - SINK, camera.position.z);
    },
  };
}
