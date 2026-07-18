// Hand-drawn whiteboard engine. Ops are queued and drawn stroke-by-stroke in
// real time with a visible pen tip, like a person sketching on a board.
// Virtual coordinate space is 1200x720, letterboxed into the canvas.

import type {
  ArrowOp,
  BoardArrowSummary,
  BoardNodeSummary,
  BoardSummary,
  DrawableOp,
  NodeOp,
  WhiteboardOp,
} from "../types";

const VW = 1200, VH = 720;
const INK = "#28323f";
const NODE_W = 180, NODE_H = 70;
const PEN_SPEED = 1050;  // virtual px per second
const CHAR_SPEED = 26;   // characters per second for type-on text

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
}

type Stroke = PathStroke | TextStroke;

interface NodeMeta { x: number; y: number; w: number; h: number; color: string; dead: boolean }

interface BoardItem {
  type: DrawableOp["op"];
  id?: string;
  op: DrawableOp;
  strokes: Stroke[];
  faded: boolean;
  meta?: NodeMeta;
  target?: string;
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

export class Whiteboard {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private items: BoardItem[] = [];
  private byId: Record<string, BoardItem> = {};
  private nodes: Record<string, BoardItem> = {};
  private queue: WhiteboardOp[] = [];
  private current: CurrentDraw | null = null;
  private _seed = 7;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  get busy(): boolean {
    return this.queue.length > 0 || !!this.current;
  }

  // Compact board state for the agent prompt (what's currently drawn).
  summary(): BoardSummary {
    const titleItem = this.items.find((i) => i.type === "title");
    const title = (titleItem && titleItem.op.op === "title" ? titleItem.op.text : null) || null;
    const nodes = Object.values(this.nodes).map((n) => {
      const op = n.op as NodeOp;
      const o: BoardNodeSummary = { id: n.id as string, label: op.label };
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

  clear(): void {
    this.items = [];
    this.byId = {};
    this.nodes = {};
    this.queue = [];
    this.current = null;
  }

  finishNow(): void {
    let guard = 500;
    while (this.busy && guard-- > 0) this.update(1);
  }

  private _rnd(): () => number {
    return mulberry32((this._seed += 1013));
  }

  private _pathStroke(basePts: Pt[], { color = INK, width = 2.5, amp = 1.5 }: { color?: string; width?: number; amp?: number } = {}): PathStroke {
    const { pts, cum, total } = withLengths(jitter(basePts, amp, this._rnd()));
    return { kind: "path", pts, cum, total, color, width, duration: Math.max(0.12, total / PEN_SPEED) };
  }

  private _textStroke(text: string, x: number, y: number, { font = '21px "Patrick Hand"', color = INK, align = "center", halo = false }: { font?: string; color?: string; align?: "left" | "center"; halo?: boolean } = {}): TextStroke {
    return { kind: "text", text, x, y, font, color, align, halo, duration: Math.max(0.15, text.length / CHAR_SPEED) };
  }

  // --- op → item planner ---
  plan(op: DrawableOp): BoardItem {
    const S: Stroke[] = [];
    const item: BoardItem = { type: op.op, id: op.id, op, strokes: S, faded: false };
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
      const a = this.nodes[op.from]?.meta, b = this.nodes[op.to]?.meta;
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

    else if (op.op === "circle") {
      const t = this.nodes[op.target]?.meta;
      if (!t) return item;
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

    return item;
  }

  private _complete(item: BoardItem): void {
    this.items.push(item);
    if (item.id) this.byId[item.id] = item;
    if (item.type === "node") this.nodes[item.id as string] = item;
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
        this.current = { item: this.plan(op), si: 0, prog: 0 };
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
    const fullW = ctx.measureText(s.text).width;
    const startX = s.align === "center" ? s.x - fullW / 2 : s.x;
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
    if (item.faded) ctx.globalAlpha = 0.26;
    const dead = item.type === "node" && item.meta?.dead;
    // fill for completed, alive nodes
    if (item.type === "node" && partialSi === Infinity && !dead && item.meta) {
      const m = item.meta;
      ctx.fillStyle = hexToRgba(m.color, 0.06);
      ctx.beginPath();
      ctx.roundRect(m.x - m.w / 2, m.y - m.h / 2, m.w, m.h, 14);
      ctx.fill();
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
    ctx.fillStyle = "rgba(31, 41, 55, 0.055)";
    for (let gx = 18; gx < cw; gx += 26)
      for (let gy = 18; gy < ch; gy += 26) ctx.fillRect(gx, gy, 2, 2);

    const s = Math.min(cw / VW, ch / VH);
    ctx.translate((cw - VW * s) / 2, (ch - VH * s) / 2);
    ctx.scale(s, s);

    for (const item of this.items) this._drawItem(ctx, item);

    if (this.current) {
      const cur = this.current;
      const tip = this._drawItem(ctx, cur.item, cur.si, cur.prog);
      if (tip) {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(40, 50, 63, 0.25)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
