// Hand-drawn whiteboard engine on an interactive infinite canvas. Ops are
// queued and drawn stroke-by-stroke in real time with a visible pen tip, like
// a person sketching on a board, while a smooth camera pans and zooms over an
// endless dot-grid world. Ops are authored against a 1200x720 "home" region;
// the camera auto-frames whatever has been drawn (follow mode) until the user
// takes over with pan/zoom, and a Fit action hands control back.

import { Camera, type Bounds } from "./camera";
import type {
  ArrowOp,
  BoardArrowSummary,
  BoardNodeSummary,
  BoardSummary,
  CodeOp,
  DrawableOp,
  NodeOp,
  WhiteboardOp,
} from "../types";

const VW = 1200, VH = 720;
const INK = "#28323f";
const NODE_W = 180, NODE_H = 70;
const CODE_W = 380;
const CARD_GAP = 28;
const PEN_SPEED = 1050;  // virtual px per second
const CHAR_SPEED = 26;   // characters per second for type-on text
const POP_DUR = 0.55;    // settle pulse after an item completes
const FADE_RATE = 6;     // alpha lerp rate toward fade target
const HOVER_RATE = 11;   // hover glow ease rate
const TRAIL_LIFE = 0.42; // pen comet trail lifetime (s)

interface Pt { x: number; y: number }

interface PathStroke {
  kind: "path";
  pts: Pt[];
  cum: number[];
  total: number;
  color: string;
  width: number;
  duration: number;
}

interface TextStroke {
  kind: "text";
  text: string;
  x: number;
  y: number;
  font: string;
  color: string;
  align: "left" | "center";
  halo: boolean;
  duration: number;
  w: number;    // measured full width (for bbox + centering)
  size: number; // font px size (for bbox height)
}

type Stroke = PathStroke | TextStroke;

interface NodeMeta { x: number; y: number; w: number; h: number; color: string; dead: boolean }

export interface BoardItem {
  type: DrawableOp["op"];
  id?: string;
  op: DrawableOp;
  strokes: Stroke[];
  faded: boolean;
  meta?: NodeMeta;
  target?: string;
  offset?: { dx: number; dy: number };
  bbox?: Bounds;
  alpha: number;     // animated opacity (fade ops ease instead of snapping)
  hoverT: number;    // eased 0→1 hover/lift emphasis
  bornClock: number; // board clock when completed, drives the settle pulse
}

interface CurrentDraw { item: BoardItem; si: number; prog: number }

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// --- geometric samplers (unjittered base points) ---

function sampleLine(pts: Pt[], ax: number, ay: number, bx: number, by: number, step = 11): void {
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(2, Math.round(len / step));
  for (let i = 0; i <= n; i++) pts.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n });
}

function sampleArc(pts: Pt[], cx: number, cy: number, r: number, a0: number, a1: number, n = 5): void {
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
}

function roundedRectPts(x: number, y: number, w: number, h: number, r = 14): Pt[] {
  const pts: Pt[] = [];
  const HP = Math.PI / 2;
  sampleLine(pts, x + r, y, x + w - r, y);
  sampleArc(pts, x + w - r, y + r, r, -HP, 0);
  sampleLine(pts, x + w, y + r, x + w, y + h - r);
  sampleArc(pts, x + w - r, y + h - r, r, 0, HP);
  sampleLine(pts, x + w - r, y + h, x + r, y + h);
  sampleArc(pts, x + r, y + h - r, r, HP, Math.PI);
  sampleLine(pts, x, y + h - r, x, y + r);
  sampleArc(pts, x + r, y + r, r, Math.PI, Math.PI + HP);
  return pts;
}

function quadPts(p0: Pt, c: Pt, p1: Pt, n = 26): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    });
  }
  return pts;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, overlap = 0.55): Pt[] {
  const pts: Pt[] = [];
  const from = -0.5, to = 2 * Math.PI + overlap;
  const n = 44;
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

function jitter(pts: Pt[], amp: number, rnd: () => number): Pt[] {
  return pts.map((p) => ({ x: p.x + (rnd() * 2 - 1) * amp, y: p.y + (rnd() * 2 - 1) * amp }));
}

function withLengths(pts: Pt[]): { pts: Pt[]; cum: number[]; total: number } {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(total);
  }
  return { pts, cum, total };
}

function rectEdgePoint(from: { x: number; y: number }, node: { x: number; y: number; w: number; h: number }, pad = 8): Pt {
  const dx = node.x - from.x || 1e-6, dy = node.y - from.y || 1e-6;
  const s = Math.min((node.w / 2 + pad) / Math.abs(dx), (node.h / 2 + pad) / Math.abs(dy));
  return { x: node.x - dx * s, y: node.y - dy * s };
}

function unionBounds(b: Bounds | null, minX: number, minY: number, maxX: number, maxY: number): Bounds {
  if (!b) return { minX, minY, maxX, maxY };
  b.minX = Math.min(b.minX, minX);
  b.minY = Math.min(b.minY, minY);
  b.maxX = Math.max(b.maxX, maxX);
  b.maxY = Math.max(b.maxY, maxY);
  return b;
}

export class Whiteboard {
  canvas: HTMLCanvasElement;
  readonly camera = new Camera();
  /** While true the camera auto-frames the drawing; any user gesture takes over. */
  follow = true;
  private ctx: CanvasRenderingContext2D;
  private items: BoardItem[] = [];
  private byId: Record<string, BoardItem> = {};
  private nodes: Record<string, BoardItem> = {};
  private queue: WhiteboardOp[] = [];
  private current: CurrentDraw | null = null;
  private _seed = 7;
  private clock = 0;
  private camReady = false;
  private hoverId: string | null = null;
  private liftId: string | null = null;
  private trail: Array<{ x: number; y: number; t: number }> = [];
  private mm = { s: 1, ox: 0, oy: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  get busy(): boolean {
    return this.queue.length > 0 || !!this.current;
  }

  get allItems(): BoardItem[] {
    return this.items;
  }

  /** Map canvas pixel coords to world space through the camera. */
  canvasToVirtual(cx: number, cy: number): { x: number; y: number } {
    return this.camera.screenToWorld({ x: cx, y: cy });
  }

  setHover(id: string | null): void {
    this.hoverId = id;
  }

  /** Mark an item as being dragged (stronger emphasis + cast shadow). */
  setLift(id: string | null): void {
    this.liftId = id;
  }

  setFollow(on: boolean): void {
    this.follow = on;
  }

  /** Hit-test items in reverse paint order (topmost first); returns first item whose meta bbox contains (vx, vy). */
  hitTest(vx: number, vy: number): BoardItem | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      const m = item.meta;
      if (!m) continue;
      const odx = item.offset?.dx ?? 0;
      const ody = item.offset?.dy ?? 0;
      const ax = m.x + odx, ay = m.y + ody;
      if (vx >= ax - m.w / 2 && vx <= ax + m.w / 2 && vy >= ay - m.h / 2 && vy <= ay + m.h / 2) return item;
    }
    return null;
  }

  /** Move an item by (dx, dy) in virtual space. Strokes stay baked; uses canvas transform offset. */
  moveItem(id: string, dx: number, dy: number): void {
    const item = this.byId[id];
    if (!item || !item.meta) return;
    if (!item.offset) item.offset = { dx: 0, dy: 0 };
    item.offset.dx += dx;
    item.offset.dy += dy;

    // Keep annotations attached to the card they describe. Arrows are
    // regenerated below from the cards' current positions.
    for (const related of this.items) {
      if (related.target !== id) continue;
      if (!related.offset) related.offset = { dx: 0, dy: 0 };
      related.offset.dx += dx;
      related.offset.dy += dy;
    }
    for (const arrow of this.items) {
      if (arrow.type !== "arrow") continue;
      const op = arrow.op as ArrowOp;
      if (op.from === id || op.to === id) {
        const fresh = this.plan(op);
        arrow.strokes = fresh.strokes;
        arrow.bbox = fresh.bbox;
      }
    }
  }

  // Compact board state for the agent prompt (what's currently drawn).
  summary(): BoardSummary {
    // Latest title wins — a follow-up topic may have re-titled the board.
    const titleItem = [...this.items].reverse().find((i) => i.type === "title");
    const title = (titleItem && titleItem.op.op === "title" ? titleItem.op.text : null) || null;
    const nodes = Object.values(this.nodes).map((n) => {
      const op = n.op as NodeOp & { file?: string };
      const meta = n.meta!;
      const o: BoardNodeSummary = {
        id: n.id as string,
        label: op.label ?? (op.file ? `code card: ${op.file}` : ""),
        x: meta.x + (n.offset?.dx ?? 0),
        y: meta.y + (n.offset?.dy ?? 0),
        w: meta.w,
        h: meta.h,
      };
      if (op.sub) o.sub = op.sub;
      if (n.meta?.dead) o.dead = true;
      return o;
    });
    const arrows = this.items
      .filter((i) => i.type === "arrow" && (i.op as ArrowOp).from)
      .map((i) => {
        const op = i.op as ArrowOp;
        const o: BoardArrowSummary = { from: op.from, to: op.to };
        if (i.id) o.id = i.id;
        if (op.label) o.label = op.label;
        if (i.faded) o.faded = true;
        return o;
      });
    return { title, nodes, arrows };
  }

  enqueue(ops: WhiteboardOp[]): void {
    for (const op of ops) this.queue.push(op);
  }

  /** True when a card would touch an already-rendered node or code card.
   * The breathing room keeps borders, labels, and hand-drawn jitter apart. */
  private collidesWithCard(x: number, y: number, w: number, h: number): boolean {
    return Object.values(this.nodes).some((item) => {
      const meta = item.meta;
      if (!meta) return false;
      const otherX = meta.x + (item.offset?.dx ?? 0);
      const otherY = meta.y + (item.offset?.dy ?? 0);
      return Math.abs(x - otherX) < (w + meta.w) / 2 + CARD_GAP
        && Math.abs(y - otherY) < (h + meta.h) / 2 + CARD_GAP;
    });
  }

  /** Find the closest open spot for a node or code card. The model normally
   * gets placement right; this is a deterministic safety net for collisions.
   * Because the same raw ops are replayed for both peers, they resolve to the
   * same positions without needing a separate sync message. */
  private resolveCardPlacement<T extends NodeOp | CodeOp>(op: T): T {
    const w = op.op === "node" ? op.w || NODE_W : CODE_W;
    const h = op.op === "node"
      ? op.h || NODE_H
      : 44 + (op.text || "").split("\n").slice(0, 4).length * 20;
    if (!this.collidesWithCard(op.x, op.y, w, h)) return op;

    // Scale the search to the incoming card. Horizontal candidates come first
    // so a layered diagram tends to stay in its original row.
    const stepX = Math.max(230, w + CARD_GAP);
    const stepY = Math.max(140, h + CARD_GAP);
    for (let ring = 1; ring <= 8; ring++) {
      const candidates: Array<{ col: number; row: number }> = [];
      for (let col = -ring; col <= ring; col++) {
        for (let row = -ring; row <= ring; row++) {
          if (Math.max(Math.abs(col), Math.abs(row)) !== ring) continue;
          candidates.push({ col, row });
        }
      }
      candidates.sort((a, b) => {
        const score = ({ col, row }: { col: number; row: number }) =>
          Math.abs(col) * stepX + Math.abs(row) * stepY * 3;
        const aScore = score(a), bScore = score(b);
        if (aScore !== bScore) return aScore - bScore;
        // Prefer moving back toward the home canvas centre when tied.
        const home = ({ col, row }: { col: number; row: number }) =>
          Math.abs(op.x + col * stepX - VW / 2) + Math.abs(op.y + row * stepY - VH / 2);
        return home(a) - home(b);
      });
      for (const candidate of candidates) {
        const x = op.x + candidate.col * stepX;
        const y = op.y + candidate.row * stepY;
        if (!this.collidesWithCard(x, y, w, h)) return { ...op, x, y } as T;
      }
    }

    // A crowded home region can grow downward; the camera/minimap already
    // auto-frame the infinite canvas, so clarity wins over forced overlap.
    const bottom = Object.values(this.nodes).reduce(
      (max, item) => Math.max(max, (item.meta?.y ?? 0) + (item.offset?.dy ?? 0) + (item.meta?.h ?? 0) / 2),
      VH
    );
    return { ...op, x: op.x, y: bottom + h / 2 + CARD_GAP } as T;
  }

  private resolvePlacement(op: DrawableOp): DrawableOp {
    if (op.op === "node" || op.op === "code") return this.resolveCardPlacement(op);
    return op;
  }

  clear(): void {
    this.items = [];
    this.byId = {};
    this.nodes = {};
    this.queue = [];
    this.current = null;
    this.trail = [];
  }

  finishNow(): void {
    let guard = 500;
    while (this.busy && guard-- > 0) this.update(1);
    // A synchronous replay (late join, barge-in) must not land as a wall of
    // popping, cross-fading items — settle everything instantly.
    for (const item of this.items) {
      item.alpha = item.faded ? 0.26 : 1;
      item.bornClock = -1e9;
    }
    this.trail = [];
  }

  /** World bounds of everything drawn (plus the item being drawn), or null. */
  contentBounds(): Bounds | null {
    let b: Bounds | null = null;
    const include = (item: BoardItem) => {
      if (!item.bbox) return;
      const dx = item.offset?.dx ?? 0, dy = item.offset?.dy ?? 0;
      b = unionBounds(b, item.bbox.minX + dx, item.bbox.minY + dy, item.bbox.maxX + dx, item.bbox.maxY + dy);
    };
    for (const item of this.items) include(item);
    if (this.current) include(this.current.item);
    return b;
  }

  private _rnd(): () => number {
    return mulberry32((this._seed += 1013));
  }

  private _pathStroke(basePts: Pt[], { color = INK, width = 2.5, amp = 1.5 }: { color?: string; width?: number; amp?: number } = {}): PathStroke {
    const { pts, cum, total } = withLengths(jitter(basePts, amp, this._rnd()));
    return { kind: "path", pts, cum, total, color, width, duration: Math.max(0.12, total / PEN_SPEED) };
  }

  private _textStroke(text: string, x: number, y: number, { font = '21px "Patrick Hand"', color = INK, align = "center", halo = false }: { font?: string; color?: string; align?: "left" | "center"; halo?: boolean } = {}): TextStroke {
    this.ctx.font = font;
    const w = this.ctx.measureText(text).width;
    const size = parseFloat(/([\d.]+)px/.exec(font)?.[1] ?? "20");
    return { kind: "text", text, x, y, font, color, align, halo, w, size, duration: Math.max(0.15, text.length / CHAR_SPEED) };
  }

  // --- op → item planner ---
  plan(op: DrawableOp): BoardItem {
    const S: Stroke[] = [];
    const item: BoardItem = { type: op.op, id: op.id, op, strokes: S, faded: false, alpha: 1, hoverT: 0, bornClock: Infinity };
    const ctx = this.ctx;

    if (op.op === "title") {
      const font = '600 36px "Caveat"';
      ctx.font = font;
      const w = ctx.measureText(op.text).width;
      S.push(this._textStroke(op.text, 56, 58, { font, align: "left" }));
      const u: Pt[] = [];
      sampleLine(u, 56, 84, 56 + w, 86);
      S.push(this._pathStroke(u, { color: "#e8a13c", width: 3, amp: 1.2 }));
    }

    else if (op.op === "node") {
      const { x, y } = op;
      const w = op.w || NODE_W, h = op.h || NODE_H;
      item.meta = { x, y, w, h, color: op.color || "#4166d5", dead: false };
      S.push(this._pathStroke(roundedRectPts(x - w / 2, y - h / 2, w, h), { color: op.color || "#4166d5", width: 2.7 }));
      if (op.sub) {
        S.push(this._textStroke(op.label, x, y - 10, { font: '22px "Patrick Hand"' }));
        S.push(this._textStroke(op.sub, x, y + 15, { font: '14px "Patrick Hand"', color: "#7c8698" }));
      } else {
        S.push(this._textStroke(op.label, x, y, { font: '22px "Patrick Hand"' }));
      }
    }

    else if (op.op === "arrow") {
      const fromItem = this.nodes[op.from], toItem = this.nodes[op.to];
      const a = fromItem?.meta && {
        ...fromItem.meta,
        x: fromItem.meta.x + (fromItem.offset?.dx ?? 0),
        y: fromItem.meta.y + (fromItem.offset?.dy ?? 0),
      };
      const b = toItem?.meta && {
        ...toItem.meta,
        x: toItem.meta.x + (toItem.offset?.dx ?? 0),
        y: toItem.meta.y + (toItem.offset?.dy ?? 0),
      };
      if (!a || !b) return item;
      const p0 = rectEdgePoint(b, a), p1 = rectEdgePoint(a, b);
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = op.bow ?? Math.min(26, len * 0.1);
      const c = { x: (p0.x + p1.x) / 2 + (-dy / len) * bow, y: (p0.y + p1.y) / 2 + (dx / len) * bow };
      const curve = quadPts(p0, c, p1);
      S.push(this._pathStroke(curve, { width: 2.4 }));
      // arrowhead: wing → tip → wing as one short stroke
      const tx = p1.x - c.x, ty = p1.y - c.y;
      const tl = Math.hypot(tx, ty) || 1;
      const ux = tx / tl, uy = ty / tl;
      const head = [
        { x: p1.x - ux * 15 - uy * 7, y: p1.y - uy * 15 + ux * 7 },
        { x: p1.x, y: p1.y },
        { x: p1.x - ux * 15 + uy * 7, y: p1.y - uy * 15 - ux * 7 },
      ];
      S.push(this._pathStroke(head, { width: 2.4, amp: 0.8 }));
      if (op.label) {
        const mid = curve[Math.floor(curve.length / 2)];
        const off = (op.bow ?? 1) >= 0 ? -16 : 20;
        S.push(this._textStroke(op.label, mid.x + (-dy / len) * off * 0.4, mid.y + off * 0.8, {
          font: '17px "Patrick Hand"', color: "#4a5462", halo: true,
        }));
      }
    }

    else if (op.op === "note") {
      const lines = op.text.split("\n");
      lines.forEach((line, i) => {
        S.push(this._textStroke(line, op.x, op.y + i * 27, { font: '19px "Patrick Hand"', color: op.color || "#5b6472" }));
      });
    }

    else if (op.op === "code") {
      const { x, y } = op;
      const lines = (op.text || "").split("\n").slice(0, 4).map((l) => l.slice(0, 46));
      const w = 380, h = 44 + lines.length * 20;
      const color = op.color || "#279c94";
      item.meta = { x, y, w, h, color, dead: false };
      S.push(this._pathStroke(roundedRectPts(x - w / 2, y - h / 2, w, h), { color, width: 2.4 }));
      const header = op.line ? `${op.file}:${op.line}` : op.file;
      S.push(this._textStroke(header, x - w / 2 + 14, y - h / 2 + 20, { font: '600 13.5px Menlo, monospace', color, align: "left" }));
      lines.forEach((ln, i) => {
        S.push(this._textStroke(ln, x - w / 2 + 14, y - h / 2 + 42 + i * 19, { font: '12px Menlo, monospace', color: "#3a4452", align: "left" }));
      });
    }

    else if (op.op === "circle") {
      const t = this.nodes[op.target]?.meta;
      if (!t) return item;
      item.target = op.target;
      S.push(this._pathStroke(ellipsePts(t.x, t.y, t.w / 2 + 22, t.h / 2 + 18), { color: op.color || "#e8a13c", width: 3.2, amp: 2 }));
    }

    else if (op.op === "cross") {
      const t = this.nodes[op.target]?.meta;
      if (!t) return item;
      item.target = op.target;
      const x0 = t.x - t.w / 2 - 8, x1 = t.x + t.w / 2 + 8;
      const y0 = t.y - t.h / 2 - 8, y1 = t.y + t.h / 2 + 8;
      const d1: Pt[] = [], d2: Pt[] = [];
      sampleLine(d1, x0, y0, x1, y1);
      sampleLine(d2, x1, y0, x0, y1);
      S.push(this._pathStroke(d1, { color: "#d94f46", width: 3.6, amp: 1.8 }));
      S.push(this._pathStroke(d2, { color: "#d94f46", width: 3.6, amp: 1.8 }));
    }

    // World-space extent of the finished item — drives camera follow, fit,
    // minimap, and the settle-pulse pivot.
    let bb: Bounds | null = null;
    for (const s of S) {
      if (s.kind === "path") {
        for (const p of s.pts) bb = unionBounds(bb, p.x, p.y, p.x, p.y);
      } else {
        const x0 = s.align === "center" ? s.x - s.w / 2 : s.x;
        bb = unionBounds(bb, x0, s.y - s.size * 0.62, x0 + s.w, s.y + s.size * 0.62);
      }
    }
    if (bb) item.bbox = bb;

    return item;
  }

  private _complete(item: BoardItem): void {
    item.bornClock = this.clock;
    this.items.push(item);
    if (item.id) this.byId[item.id] = item;
    if (item.type === "node" || item.type === "code") this.nodes[item.id as string] = item;
    if (item.type === "cross" && item.target && this.nodes[item.target]) this.nodes[item.target].meta!.dead = true;
  }

  update(dt: number): void {
    let budget = dt;
    let guard = 200;
    while (budget > 0 && guard-- > 0) {
      if (!this.current) {
        const op = this.queue.shift();
        if (!op) return;
        if (op.op === "clear") {
          this.items = []; this.byId = {}; this.nodes = {};
          continue;
        }
        if (op.op === "fade") {
          for (const id of op.ids) if (this.byId[id]) this.byId[id].faded = true;
          continue;
        }
        this.current = { item: this.plan(this.resolvePlacement(op)), si: 0, prog: 0 };
      }
      const cur = this.current;
      if (cur.si >= cur.item.strokes.length) {
        this._complete(cur.item);
        this.current = null;
        budget -= 0.06; // tiny pen-lift pause between items
        continue;
      }
      const s = cur.item.strokes[cur.si];
      const need = s.duration - cur.prog;
      if (budget >= need) {
        budget -= need;
        cur.prog = 0;
        cur.si++;
      } else {
        cur.prog += budget;
        budget = 0;
      }
    }
  }

  /** Per-frame driver: advances drawing, eased item states, camera, then paints. */
  frame(dt: number): void {
    this.clock += dt;
    this.update(dt);

    for (const item of this.items) {
      const alphaTarget = item.faded ? 0.26 : 1;
      item.alpha += (alphaTarget - item.alpha) * Math.min(1, dt * FADE_RATE);
      const hoverTarget = item.id && (item.id === this.hoverId || item.id === this.liftId) ? 1 : 0;
      item.hoverT += (hoverTarget - item.hoverT) * Math.min(1, dt * HOVER_RATE);
    }

    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (cw && ch) {
      if (this.follow) this.followContent(cw, ch);
      if (!this.camReady) { this.camera.snap(); this.camReady = true; }
      this.camera.update(dt);
    }

    this.render();
    const cutoff = this.clock - TRAIL_LIFE;
    if (this.trail.length && this.trail[0].t < cutoff) this.trail = this.trail.filter((p) => p.t >= cutoff);
  }

  /** Auto-frame the drawing (never tighter than a comfortable reading size). */
  private followContent(cw: number, ch: number): void {
    let b = this.contentBounds();
    if (!b) b = { minX: 0, minY: 0, maxX: VW, maxY: VH };
    const minW = 720, minH = 450;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const w = Math.max(b.maxX - b.minX, minW), h = Math.max(b.maxY - b.minY, minH);
    this.camera.fitBounds({ minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 }, cw, ch, 72, 1.05);
  }

  // --- rendering ---

  private _drawPath(ctx: CanvasRenderingContext2D, s: PathStroke, upTo = Infinity): Pt {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(s.pts[0].x, s.pts[0].y);
    let tip = s.pts[0];
    for (let i = 1; i < s.pts.length; i++) {
      if (s.cum[i] <= upTo) {
        ctx.lineTo(s.pts[i].x, s.pts[i].y);
        tip = s.pts[i];
      } else {
        const prev = s.pts[i - 1];
        const seg = s.cum[i] - s.cum[i - 1] || 1;
        const t = (upTo - s.cum[i - 1]) / seg;
        tip = { x: prev.x + (s.pts[i].x - prev.x) * t, y: prev.y + (s.pts[i].y - prev.y) * t };
        ctx.lineTo(tip.x, tip.y);
        break;
      }
    }
    ctx.stroke();
    return tip;
  }

  private _drawText(ctx: CanvasRenderingContext2D, s: TextStroke, chars = Infinity): Pt {
    const text = chars >= s.text.length ? s.text : s.text.slice(0, Math.max(0, Math.floor(chars)));
    ctx.font = s.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const startX = s.align === "center" ? s.x - s.w / 2 : s.x;
    if (s.halo && text) {
      ctx.strokeStyle = "#fdfcf9";
      ctx.lineWidth = 6;
      ctx.strokeText(text, startX, s.y);
    }
    ctx.fillStyle = s.color;
    ctx.fillText(text, startX, s.y);
    return { x: startX + ctx.measureText(text).width + 2, y: s.y };
  }

  private _drawItem(ctx: CanvasRenderingContext2D, item: BoardItem, partialSi = Infinity, partialProg = 0): Pt | null {
    ctx.save();
    ctx.globalAlpha = item.alpha;
    if (item.offset) ctx.translate(item.offset.dx, item.offset.dy);

    // Settle pulse (fresh items) + hover emphasis, scaled about the item center.
    const bb = item.bbox;
    const popT = (this.clock - item.bornClock) / POP_DUR;
    let scale = 1;
    if (popT >= 0 && popT < 1) scale *= 1 + 0.045 * Math.sin(popT * Math.PI);
    if (item.hoverT > 0.001) scale *= 1 + (item.id === this.liftId ? 0.024 : 0.014) * item.hoverT;
    if (scale !== 1 && bb) {
      const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
    }

    const dead = item.type === "node" && item.meta?.dead;
    const m = item.meta;

    // Cast shadow while an item is being dragged around.
    if (m && item.id === this.liftId && item.hoverT > 0.02) {
      ctx.fillStyle = `rgba(30, 40, 55, ${0.10 * item.hoverT})`;
      ctx.beginPath();
      ctx.roundRect(m.x - m.w / 2 - 2, m.y - m.h / 2 + 4, m.w + 4, m.h + 4, 16);
      ctx.fill();
    }

    // fill for completed, alive nodes — eases in with the settle pulse,
    // deepens on hover.
    if ((item.type === "node" || item.type === "code") && partialSi === Infinity && !dead && m) {
      const fillIn = Math.min(1, Math.max(0, popT * 2));
      ctx.fillStyle = hexToRgba(m.color, (0.06 + 0.05 * item.hoverT) * fillIn);
      ctx.beginPath();
      ctx.roundRect(m.x - m.w / 2, m.y - m.h / 2, m.w, m.h, 14);
      ctx.fill();
    }

    // Hover glow: soft ring just outside the card, in the card's own color.
    if (m && item.hoverT > 0.02 && !dead) {
      const pad = 5;
      for (const [lw, a] of [[9, 0.08], [3.5, 0.18]] as const) {
        ctx.strokeStyle = hexToRgba(m.color, a * item.hoverT);
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.roundRect(m.x - m.w / 2 - pad, m.y - m.h / 2 - pad, m.w + pad * 2, m.h + pad * 2, 18);
        ctx.stroke();
      }
    }

    let tip: Pt | null = null;
    for (let i = 0; i < item.strokes.length; i++) {
      if (i > partialSi) break;
      const s = item.strokes[i];
      const partial = i === partialSi;
      let color = s.color;
      if (dead && s.color !== "#d94f46") color = "#9aa4b2";
      if (s.kind === "path") {
        const painted: PathStroke = { ...s, color };
        const upTo = partial ? (partialProg / s.duration) * s.total : Infinity;
        tip = this._drawPath(ctx, painted, upTo);
      } else {
        const painted: TextStroke = { ...s, color };
        const chars = partial ? (partialProg / s.duration) * s.text.length : Infinity;
        tip = this._drawText(ctx, painted, chars);
      }
    }

    // Completed arrows carry a slow ember current so flow direction reads at
    // a glance even on a still board.
    if (item.type === "arrow" && partialSi === Infinity && item.strokes[0]?.kind === "path") {
      const main = item.strokes[0];
      ctx.save();
      ctx.setLineDash([11, 17]);
      ctx.lineDashOffset = -((this.clock * 26) % 28);
      ctx.strokeStyle = "rgba(232, 161, 60, 0.5)";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(main.pts[0].x, main.pts[0].y);
      for (let i = 1; i < main.pts.length; i++) ctx.lineTo(main.pts[i].x, main.pts[i].y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
    return tip;
  }

  render(): void {
    const { canvas, ctx } = this;
    const d = devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * d) || canvas.height !== Math.round(ch * d)) {
      canvas.width = Math.round(cw * d);
      canvas.height = Math.round(ch * d);
    }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = "#fdfcf9";
    ctx.fillRect(0, 0, cw, ch);

    const cam = this.camera;
    ctx.save();
    ctx.scale(cam.z, cam.z);
    ctx.translate(cam.x, cam.y);

    this.drawGrid(ctx, cw, ch);

    for (const item of this.items) this._drawItem(ctx, item);

    if (this.current) {
      const cur = this.current;
      const tip = this._drawItem(ctx, cur.item, cur.si, cur.prog);
      const stroke = cur.item.strokes[cur.si];
      if (tip && stroke?.kind === "path") {
        const last = this.trail[this.trail.length - 1];
        if (!last || last.x !== tip.x || last.y !== tip.y) this.trail.push({ x: tip.x, y: tip.y, t: this.clock });
      }
      this.drawTrail(ctx);
      if (tip) this.drawPenTip(ctx, tip);
    } else {
      this.drawTrail(ctx);
    }

    ctx.restore();

    // Soft paper vignette keeps the eye on the drawing.
    const g = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.42, cw / 2, ch / 2, Math.max(cw, ch) * 0.78);
    g.addColorStop(0, "rgba(40, 50, 63, 0)");
    g.addColorStop(1, "rgba(40, 50, 63, 0.05)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  }

  /** Infinite dot grid in world space; spacing snaps by powers of two so the
   * screen density stays comfortable at any zoom. */
  private drawGrid(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const z = this.camera.z;
    let step = 26;
    while (step * z < 19) step *= 2;
    while (step * z > 46) step /= 2;
    const tl = this.camera.screenToWorld({ x: 0, y: 0 });
    const br = this.camera.screenToWorld({ x: cw, y: ch });
    const r = 1.1 / z;
    ctx.fillStyle = "rgba(31, 41, 55, 0.055)";
    const x0 = Math.floor(tl.x / step) * step;
    const y0 = Math.floor(tl.y / step) * step;
    for (let x = x0; x <= br.x; x += step) {
      for (let y = y0; y <= br.y; y += step) {
        const major = Math.round(x / step) % 4 === 0 && Math.round(y / step) % 4 === 0;
        const s = major ? r * 1.8 : r * 1.15;
        ctx.fillRect(x - s, y - s, s * 2, s * 2);
      }
    }
  }

  /** Fading comet behind the live pen tip. */
  private drawTrail(ctx: CanvasRenderingContext2D): void {
    for (const p of this.trail) {
      const a = (this.clock - p.t) / TRAIL_LIFE;
      if (a >= 1) continue;
      ctx.fillStyle = `rgba(40, 50, 63, ${0.28 * (1 - a)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.5 + 2.6 * (1 - a), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPenTip(ctx: CanvasRenderingContext2D, tip: Pt): void {
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(40, 50, 63, 0.25)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 8 + Math.sin(this.clock * 5.2) * 1.1, 0, Math.PI * 2);
    ctx.stroke();
  }

  // --- minimap ---

  /** Paint the overview map onto its own small canvas (called each frame). */
  renderMinimap(mm: HTMLCanvasElement, mainW: number, mainH: number): void {
    const d = devicePixelRatio || 1;
    const mw = mm.clientWidth, mh = mm.clientHeight;
    if (!mw || !mh) return;
    if (mm.width !== Math.round(mw * d) || mm.height !== Math.round(mh * d)) {
      mm.width = Math.round(mw * d);
      mm.height = Math.round(mh * d);
    }
    const ctx = mm.getContext("2d")!;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, mw, mh);

    let b = this.contentBounds();
    b = unionBounds(b, 0, 0, VW, VH);
    // Always keep the viewport indicator inside the map — a user who panned
    // into empty space must still see where they are relative to the drawing.
    const vtl = this.camera.screenToWorld({ x: 0, y: 0 });
    const vbr = this.camera.screenToWorld({ x: mainW, y: mainH });
    b = unionBounds(b, vtl.x, vtl.y, vbr.x, vbr.y);
    const pad = 60;
    const bw = b.maxX - b.minX + pad * 2, bh = b.maxY - b.minY + pad * 2;
    const s = Math.min(mw / bw, mh / bh);
    const ox = (mw - (b.maxX - b.minX) * s) / 2 - b.minX * s;
    const oy = (mh - (b.maxY - b.minY) * s) / 2 - b.minY * s;
    this.mm = { s, ox, oy };
    const X = (wx: number) => wx * s + ox;
    const Y = (wy: number) => wy * s + oy;

    // arrows first (under the cards)
    for (const item of this.items) {
      if (item.type !== "arrow") continue;
      const op = item.op as ArrowOp;
      const f = this.nodes[op.from], t = this.nodes[op.to];
      if (!f?.meta || !t?.meta) continue;
      ctx.strokeStyle = `rgba(180, 190, 205, ${0.5 * item.alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(f.meta.x + (f.offset?.dx ?? 0)), Y(f.meta.y + (f.offset?.dy ?? 0)));
      ctx.lineTo(X(t.meta.x + (t.offset?.dx ?? 0)), Y(t.meta.y + (t.offset?.dy ?? 0)));
      ctx.stroke();
    }
    for (const item of this.items) {
      if (item.type === "title" && item.bbox) {
        ctx.fillStyle = `rgba(232, 161, 60, ${0.85 * item.alpha})`;
        ctx.beginPath();
        ctx.roundRect(X(item.bbox.minX), Y(item.bbox.minY), Math.max(6, (item.bbox.maxX - item.bbox.minX) * s), 2.5, 1.5);
        ctx.fill();
        continue;
      }
      const m = item.meta;
      if (!m) continue;
      const dx = item.offset?.dx ?? 0, dy = item.offset?.dy ?? 0;
      ctx.fillStyle = m.dead ? `rgba(154, 164, 178, ${0.8 * item.alpha})` : hexToRgba(m.color, 0.85 * item.alpha);
      ctx.beginPath();
      ctx.roundRect(X(m.x + dx - m.w / 2), Y(m.y + dy - m.h / 2), Math.max(3, m.w * s), Math.max(3, m.h * s), 2);
      ctx.fill();
    }

    // viewport rectangle
    const tl = this.camera.screenToWorld({ x: 0, y: 0 });
    const brw = this.camera.screenToWorld({ x: mainW, y: mainH });
    ctx.strokeStyle = "rgba(255, 106, 40, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(X(tl.x), Y(tl.y), (brw.x - tl.x) * s, (brw.y - tl.y) * s, 3);
    ctx.stroke();
  }

  /** Map a minimap canvas point back to world coords (for click-to-jump). */
  minimapToWorld(mx: number, my: number): Pt {
    return { x: (mx - this.mm.ox) / this.mm.s, y: (my - this.mm.oy) / this.mm.s };
  }
}
