// Smooth pan/zoom camera for the whiteboard, using the standard infinite-
// canvas model (tldraw/Figma): screen = (world + cam) * zoom. User gestures
// mutate the camera directly for 1:1 feel; programmatic moves (fit, follow,
// minimap jumps) set a target that the camera glides toward each frame.

export interface Pt { x: number; y: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

const MIN_Z = 0.12;
const MAX_Z = 4;
const GLIDE = 7; // exponential smoothing rate toward target (higher = snappier)

export class Camera {
  x = 0;
  y = 0;
  z = 1;
  private tx = 0;
  private ty = 0;
  private tz = 1;

  screenToWorld(p: Pt): Pt {
    return { x: p.x / this.z - this.x, y: p.y / this.z - this.y };
  }

  worldToScreen(p: Pt): Pt {
    return { x: (p.x + this.x) * this.z, y: (p.y + this.y) * this.z };
  }

  /** Immediately move the view by a screen-space delta (drag pan). */
  panBy(dxScreen: number, dyScreen: number): void {
    this.x += dxScreen / this.z;
    this.y += dyScreen / this.z;
    this.tx = this.x; this.ty = this.y; this.tz = this.z;
  }

  /** Immediately zoom by `factor` keeping the screen point `p` fixed. */
  zoomAt(p: Pt, factor: number): void {
    const z2 = Math.min(MAX_Z, Math.max(MIN_Z, this.z * factor));
    this.x += p.x / z2 - p.x / this.z;
    this.y += p.y / z2 - p.y / this.z;
    this.z = z2;
    this.tx = this.x; this.ty = this.y; this.tz = this.z;
  }

  /** Glide so `bounds` (world) fits a viewport of vw×vh css px with padding. */
  fitBounds(b: Bounds, vw: number, vh: number, pad = 70, maxZ = 1.15): void {
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    const z = Math.min(maxZ, Math.max(MIN_Z, Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh)));
    this.tz = z;
    this.tx = (vw / z - bw) / 2 - b.minX;
    this.ty = (vh / z - bh) / 2 - b.minY;
  }

  /** Glide until the world point sits at the viewport center (minimap jump). */
  centerOn(world: Pt, vw: number, vh: number, z = this.tz): void {
    this.tz = Math.min(MAX_Z, Math.max(MIN_Z, z));
    this.tx = vw / (2 * this.tz) - world.x;
    this.ty = vh / (2 * this.tz) - world.y;
  }

  /** Glide zoom by `factor` about the viewport center (HUD +/− buttons). */
  zoomStep(factor: number, vw: number, vh: number): void {
    const z2 = Math.min(MAX_Z, Math.max(MIN_Z, this.tz * factor));
    const cx = vw / 2, cy = vh / 2;
    this.tx += cx / z2 - cx / this.tz;
    this.ty += cy / z2 - cy / this.tz;
    this.tz = z2;
  }

  /** Jump straight to the target (first frame, so the view never glides in from origin). */
  snap(): void {
    this.x = this.tx; this.y = this.ty; this.z = this.tz;
  }

  /** Advance the glide toward the target. Returns true while still moving. */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * GLIDE);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    this.z *= Math.pow(this.tz / this.z, k);
    const settled =
      Math.abs(this.tx - this.x) * this.z < 0.25 &&
      Math.abs(this.ty - this.y) * this.z < 0.25 &&
      Math.abs(Math.log(this.tz / this.z)) < 0.002;
    if (settled) { this.x = this.tx; this.y = this.ty; this.z = this.tz; }
    return !settled;
  }
}
