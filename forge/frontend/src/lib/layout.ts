// Deterministic auto-layout for whiteboard ops. The model's x/y values are
// treated as hints only: before a response is drawn (or cast to the peer), the
// full batch of ops is rewritten so that nothing on the board overlaps —
// cards, notes, code cards, arrow curves, arrow labels, and the title all get
// collision-checked positions. Existing board items (including ones the user
// dragged) are never moved; new items are placed around them.
//
// The pipeline per batch: dedupe re-emitted content → drop invalid refs →
// layer the graph (longest path from sources, pinned items keep their rows) →
// order rows by neighbor barycenter → place cards collision-free → choose
// arrow bows that dodge cards → place free-floating notes/code cards clear of
// cards and arrow corridors → place arrow labels in the emptiest nearby spot.

import type { AgentStep, ArrowOp, CodeOp, NodeOp, NoteOp, WhiteboardOp } from "../types";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export interface LayoutCard extends Rect {
  id: string;
  /** a circle op targets this card — its highlight ring needs clearance */
  ringed?: boolean;
  /** code cards: file:line identity used to drop duplicate cards */
  codeKey?: string;
}

/** Snapshot of what is already on the board (rendered positions, offsets applied). */
export interface LayoutBoardState {
  cards: LayoutCard[];
  notes: Rect[];
  arrows: Array<{ from: string; to: string }>;
  arrowPaths: Pt[][];
  hasTitle: boolean;
}

const NODE_W = 180, NODE_H = 70;
const CODE_W = 380;
const GAP = 28;              // required clear margin between any two rects
const RING_PAD = 26;         // extra clearance around a circled card
const TOP_Y = 170;           // first card row
const ROW_H = 190;           // vertical rhythm between rows
const COL_STEP = 24;         // x scan granularity when resolving collisions
const TITLE_ZONE: Rect = { x: 380, y: 60, w: 760, h: 96 }; // center-based (56..~760 x 12..108)
const NOTE_LINE_H = 27;
const MAX_LAYER = 12;

// ---------- text measurement (canvas when available, heuristic fallback) ----------

let measureCtx: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, font: string, pxSize: number): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== "undefined"
        ? document.createElement("canvas").getContext("2d")
        : null;
    } catch {
      measureCtx = null;
    }
  }
  if (measureCtx) {
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }
  return text.length * pxSize * 0.52;
}

const noteWidth = (line: string) => measureText(line, '19px "Patrick Hand"', 19);
const labelWidth = (line: string) => measureText(line, '17px "Patrick Hand"', 17);

// ---------- geometry ----------

const inflate = (r: Rect, pad: number): Rect => ({ x: r.x, y: r.y, w: r.w + pad * 2, h: r.h + pad * 2 });

function rectsOverlap(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
}

function pointInRect(p: Pt, r: Rect): boolean {
  return Math.abs(p.x - r.x) * 2 < r.w && Math.abs(p.y - r.y) * 2 < r.h;
}

function cardObstacle(c: LayoutCard): Rect {
  return c.ringed ? inflate(c, RING_PAD) : c;
}

/** Sample the quadratic arrow curve exactly like the whiteboard draws it. */
function arrowCurve(a: Rect, b: Rect, bow: number, n = 28): Pt[] {
  const edgePoint = (from: Rect, node: Rect, pad = 8): Pt => {
    const dx = node.x - from.x || 1e-6, dy = node.y - from.y || 1e-6;
    const s = Math.min((node.w / 2 + pad) / Math.abs(dx), (node.h / 2 + pad) / Math.abs(dy));
    return { x: node.x - dx * s, y: node.y - dy * s };
  };
  const p0 = edgePoint(b, a), p1 = edgePoint(a, b);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const c = { x: (p0.x + p1.x) / 2 + (-dy / len) * bow, y: (p0.y + p1.y) / 2 + (dx / len) * bow };
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

// ---------- op bookkeeping ----------

interface Entry {
  op: WhiteboardOp;
  si: number;       // step index the op plays in
  order: number;    // original flat order (stable sorts)
  dropped: boolean;
}

interface SegmentState {
  cards: Map<string, LayoutCard>;
  notes: Rect[];
  arrows: Array<{ from: string; to: string }>;
  arrowPaths: Pt[][];
  labelRects: Rect[];
  hasTitle: boolean;
}

const wordWrap = (text: string, max = 40): string[] => {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/)) {
      if (!line) line = word;
      else if ((line + " " + word).length <= max) line += " " + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out.slice(0, 4);
};

const codeKeyOf = (op: CodeOp): string => `${op.file}:${op.line ?? ""}`;

/**
 * Rewrite a batch of steps so every new op lands in a collision-free spot.
 * Existing board content is respected and never moved. Deterministic: the
 * same board + steps always produce the same output (the owner runs this once
 * and casts the final ops to the peer).
 */
export function layoutSteps(state: LayoutBoardState | null, steps: AgentStep[]): AgentStep[] {
  const entries: Entry[] = [];
  steps.forEach((step, si) => {
    for (const op of step.ops ?? []) entries.push({ op, si, order: entries.length, dropped: false });
  });
  if (!entries.length) return steps;

  // Split at "clear": each segment lays out against the board it will see.
  const segments: Entry[][] = [];
  let seg: Entry[] = [];
  let cleared = false;
  for (const e of entries) {
    if (e.op.op === "clear") {
      if (seg.length) segments.push(seg);
      seg = [];
      cleared = true;
      continue;
    }
    seg.push(e);
  }
  if (seg.length) segments.push(seg);

  let boardState: LayoutBoardState | null = cleared ? null : state;
  for (let i = 0; i < segments.length; i++) {
    // Only the first segment sees the pre-existing board; a clear wiped it for
    // the rest (layoutSegment threads its own produced state forward).
    boardState = layoutSegment(boardState, segments[i]);
  }

  // Arrows and decorations must play after the cards they reference.
  const bySi = new Map<string, number>();
  for (const e of entries) {
    if (e.dropped) continue;
    const op = e.op;
    if ((op.op === "node" || op.op === "code") && op.id) bySi.set(op.id, e.si);
  }
  for (const e of entries) {
    if (e.dropped) continue;
    const op = e.op;
    if (op.op === "arrow") {
      e.si = Math.max(e.si, bySi.get(op.from) ?? 0, bySi.get(op.to) ?? 0);
    } else if (op.op === "circle" || op.op === "cross") {
      e.si = Math.max(e.si, bySi.get(op.target) ?? 0);
    }
  }

  return steps.map((step, si) => ({
    ...step,
    ops: entries
      .filter((e) => !e.dropped && e.si === si)
      .sort((a, b) => a.order - b.order)
      .map((e) => e.op),
  }));
}

function segmentState(state: LayoutBoardState | null): SegmentState {
  return {
    cards: new Map((state?.cards ?? []).map((c) => [c.id, { ...c }])),
    notes: [...(state?.notes ?? [])],
    arrows: [...(state?.arrows ?? [])],
    arrowPaths: [...(state?.arrowPaths ?? [])],
    labelRects: [],
    hasTitle: state?.hasTitle ?? false,
  };
}

function layoutSegment(prior: LayoutBoardState | null, entries: Entry[]): LayoutBoardState {
  const s = segmentState(prior);

  // ---- pass 1: catalogue, dedupe, drop invalid references ----
  const newNodes: Array<{ e: Entry; op: NodeOp; w: number; h: number }> = [];
  const newCodes: Array<{ e: Entry; op: CodeOp; w: number; h: number; key: string }> = [];
  const newNotes: Array<{ e: Entry; op: NoteOp; lines: string[]; w: number; h: number }> = [];
  const newArrows: Array<{ e: Entry; op: ArrowOp }> = [];
  const idAlias = new Map<string, string>();
  const seenCodeKeys = new Map<string, string>(); // codeKey → surviving card id
  for (const c of s.cards.values()) if (c.codeKey) seenCodeKeys.set(c.codeKey, c.id);

  for (const e of entries) {
    const op = e.op;
    if (op.op === "title") {
      s.hasTitle = true;
    } else if (op.op === "node") {
      if (!op.id || s.cards.has(op.id)) { e.dropped = true; continue; } // re-emit of a live card
      newNodes.push({ e, op, w: op.w || NODE_W, h: op.h || NODE_H });
      s.cards.set(op.id, { id: op.id, x: 0, y: 0, w: op.w || NODE_W, h: op.h || NODE_H });
    } else if (op.op === "code") {
      const key = codeKeyOf(op);
      const existing = seenCodeKeys.get(key);
      if (existing) { // identical card already on the board — reuse it
        e.dropped = true;
        if (op.id) idAlias.set(op.id, existing);
        continue;
      }
      if (!op.id || s.cards.has(op.id)) { e.dropped = true; continue; }
      const lines = (op.text || "").split("\n").slice(0, 4);
      const h = 44 + Math.max(1, lines.length) * 20;
      newCodes.push({ e, op, w: CODE_W, h, key });
      seenCodeKeys.set(key, op.id);
      s.cards.set(op.id, { id: op.id, x: 0, y: 0, w: CODE_W, h, codeKey: key });
    } else if (op.op === "note") {
      const lines = wordWrap(op.text || "");
      if (!lines.length) { e.dropped = true; continue; }
      if (lines.join("\n") !== op.text) e.op = { ...op, text: lines.join("\n") };
      const w = Math.max(...lines.map(noteWidth), 24);
      newNotes.push({ e, op: e.op as NoteOp, lines, w, h: lines.length * NOTE_LINE_H });
    } else if (op.op === "arrow") {
      const from = idAlias.get(op.from) ?? op.from;
      const to = idAlias.get(op.to) ?? op.to;
      if (!s.cards.has(from) || !s.cards.has(to) || from === to) { e.dropped = true; continue; }
      if (from !== op.from || to !== op.to) e.op = { ...op, from, to };
      const dup = s.arrows.some((a) => a.from === from && a.to === to)
        || newArrows.some((a) => a.op.from === from && a.op.to === to);
      if (dup) { e.dropped = true; continue; }
      newArrows.push({ e, op: e.op as ArrowOp });
    } else if (op.op === "circle" || op.op === "cross") {
      const target = idAlias.get(op.target) ?? op.target;
      const card = s.cards.get(target);
      if (!card) { e.dropped = true; continue; }
      if (target !== op.target) e.op = { ...op, target };
      if (op.op === "circle") card.ringed = true;
    }
    // fade: passes through untouched
  }

  const pinned = new Set(
    [...s.cards.keys()].filter(
      (id) => !newNodes.some((n) => n.op.id === id) && !newCodes.some((c) => c.op.id === id)
    )
  );

  // Code cards referenced by arrows behave like graph nodes; the rest float.
  const arrowTouches = new Set(newArrows.flatMap((a) => [a.op.from, a.op.to]).concat(s.arrows.flatMap((a) => [a.from, a.to])));
  const graphNew = [
    ...newNodes.map((n) => ({ kind: "node" as const, ...n })),
    ...newCodes.filter((c) => arrowTouches.has(c.op.id)).map((c) => ({ kind: "code" as const, ...c })),
  ].sort((a, b) => a.e.order - b.e.order);
  const satCodes = newCodes.filter((c) => !arrowTouches.has(c.op.id));

  // ---- pass 2: layer assignment ----
  const allEdges = [
    ...s.arrows,
    ...newArrows.map((a) => ({ from: a.op.from, to: a.op.to })),
  ];
  const layer = new Map<string, number>();
  for (const id of pinned) {
    const c = s.cards.get(id)!;
    layer.set(id, Math.max(0, Math.round((c.y - TOP_Y) / ROW_H)));
  }
  const hintLayer = (y: number | undefined): number | null =>
    typeof y === "number" && Number.isFinite(y) ? Math.min(4, Math.max(0, Math.round((y - TOP_Y) / ROW_H))) : null;
  for (const g of graphNew) {
    const h = hintLayer(g.op.y);
    if (h !== null) layer.set(g.op.id, h);
  }
  // Seed unhinted roots (no incoming edges) at the top row so the flow can
  // cascade downward even when the model gave no usable coordinates.
  const hasIncoming = new Set(allEdges.map((e) => e.to));
  for (const g of graphNew) {
    if (!layer.has(g.op.id) && !hasIncoming.has(g.op.id)) layer.set(g.op.id, 0);
  }
  // Longest-path relaxation: children sit below parents. Pinned cards never move.
  const relax = () => {
    let changed = true;
    for (let guard = 0; changed && guard < 24; guard++) {
      changed = false;
      for (const edge of allEdges) {
        if (pinned.has(edge.to)) continue;
        const lu = layer.get(edge.from);
        if (lu === undefined) continue;
        const lv = layer.get(edge.to);
        const want = Math.min(MAX_LAYER, lu + 1);
        if (lv === undefined || lv < want) { layer.set(edge.to, want); changed = true; }
      }
    }
  };
  relax();
  // Stragglers (cycle members, isolated cards): default to row 1, then let
  // their children settle below them.
  for (const g of graphNew) if (!layer.has(g.op.id)) layer.set(g.op.id, 1);
  relax();

  // ---- pass 3: x placement, layer by layer, barycenter then collision scan ----
  const placed = new Map<string, Rect>();
  for (const id of pinned) placed.set(id, { ...s.cards.get(id)! });

  const neighborsOf = (id: string): string[] =>
    allEdges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []));

  const collides = (r: Rect, ignoreId?: string): boolean => {
    for (const [pid, p] of placed) {
      if (pid === ignoreId) continue;
      const obstacle = s.cards.get(pid);
      if (rectsOverlap(inflate(r, GAP / 2), obstacle ? inflate(cardObstacle(obstacle), GAP / 2) : inflate(p, GAP / 2))) return true;
    }
    for (const n of s.notes) if (rectsOverlap(inflate(r, GAP / 2), inflate(n, GAP / 2))) return true;
    if (s.hasTitle && rectsOverlap(r, TITLE_ZONE)) return true;
    return false;
  };

  const maxLayerUsed = Math.max(0, ...[...layer.values()]);
  for (let L = 0; L <= maxLayerUsed; L++) {
    const members = graphNew.filter((g) => layer.get(g.op.id) === L);
    if (!members.length) continue;
    const desired = members.map((g) => {
      const anchors = neighborsOf(g.op.id)
        .map((n) => placed.get(n))
        .filter((r): r is Rect => !!r)
        .map((r) => r.x);
      const x = anchors.length
        ? anchors.reduce((a, b) => a + b, 0) / anchors.length
        : typeof g.op.x === "number" && Number.isFinite(g.op.x) ? g.op.x : 600;
      return { g, x };
    });
    desired.sort((a, b) => a.x - b.x || a.g.e.order - b.g.e.order);
    for (const { g, x } of desired) {
      const y = TOP_Y + L * ROW_H;
      let spot: Rect | null = null;
      // Scan outward on the row; then drop half-rows below if the row is jammed.
      outer: for (let vStep = 0; vStep <= 6; vStep++) {
        const yy = y + (vStep % 2 === 1 ? Math.ceil(vStep / 2) : -Math.ceil(vStep / 2)) * (ROW_H / 2);
        if (yy < TOP_Y - 20) continue;
        for (let i = 0; i <= 90; i++) {
          const dx = (i % 2 === 1 ? Math.ceil(i / 2) : -Math.ceil(i / 2)) * COL_STEP;
          const candidate: Rect = { x: Math.round(x + dx), y: yy, w: g.w, h: g.h };
          if (!collides(candidate)) { spot = candidate; break outer; }
        }
      }
      if (!spot) { // fully jammed — park below everything
        const bottom = Math.max(TOP_Y, ...[...placed.values()].map((r) => r.y + r.h / 2));
        spot = { x: 600, y: bottom + GAP + g.h / 2, w: g.w, h: g.h };
      }
      placed.set(g.op.id, spot);
      const card = s.cards.get(g.op.id)!;
      card.x = spot.x; card.y = spot.y;
      g.e.op = { ...g.op, x: spot.x, y: spot.y } as WhiteboardOp;
    }
  }

  // ---- pass 4: arrow bows that dodge cards ----
  const liveArrows: Array<{ from: string; to: string; op?: ArrowOp; e?: Entry; path: Pt[] }> = [];
  for (const path of s.arrowPaths) liveArrows.push({ from: "", to: "", path });
  for (const a of newArrows) {
    const from = s.cards.get(a.op.from)!;
    const to = s.cards.get(a.op.to)!;
    const tried = typeof a.op.bow === "number" && Number.isFinite(a.op.bow) ? [a.op.bow] : [];
    const candidates = [...tried, 0, 30, -30, 60, -60, 100, -100, 150, -150, 210, -210];
    let best: { bow: number; path: Pt[]; score: number } | null = null;
    for (const bow of candidates) {
      const path = arrowCurve(cardObstacle(from), cardObstacle(to), bow);
      let score = Math.abs(bow) * 0.02;
      for (const p of path) {
        for (const c of s.cards.values()) {
          if (c.id === a.op.from || c.id === a.op.to) continue;
          if (pointInRect(p, inflate(cardObstacle(c), 10))) score += 10;
        }
        for (const n of s.notes) if (pointInRect(p, inflate(n, 8))) score += 6;
        if (s.hasTitle && pointInRect(p, TITLE_ZONE)) score += 6;
      }
      if (!best || score < best.score) best = { bow, path, score };
      if (best.score <= Math.abs(bow) * 0.02) break; // clean path found
    }
    const chosen = best!;
    a.e.op = { ...(a.e.op as ArrowOp), bow: chosen.bow };
    liveArrows.push({ from: a.op.from, to: a.op.to, op: a.e.op as ArrowOp, e: a.e, path: chosen.path });
  }

  const nearArrow = (r: Rect, pad = 12): boolean =>
    liveArrows.some((a) => a.path.some((p) => pointInRect(p, inflate(r, pad))));

  // ---- pass 5: free-floating notes and unconnected code cards ----
  const placeSatellite = (hintX: number | undefined, hintY: number | undefined, w: number, h: number): Pt => {
    const contentBottom = Math.max(TOP_Y, ...[...placed.values()].map((r) => r.y + r.h / 2), ...s.notes.map((n) => n.y + n.h / 2));
    const cx = typeof hintX === "number" && Number.isFinite(hintX) ? hintX : 600;
    const cy = typeof hintY === "number" && Number.isFinite(hintY) ? hintY : contentBottom + GAP * 2 + h / 2;
    const free = (r: Rect) => !collides(r) && !nearArrow(r);
    // Deterministic spiral over grid offsets, nearest first.
    const offsets: Array<{ dx: number; dy: number; d: number }> = [];
    for (let gx = -14; gx <= 14; gx++) {
      for (let gy = -10; gy <= 10; gy++) {
        const dx = gx * 55, dy = gy * 48;
        offsets.push({ dx, dy, d: Math.hypot(dx, dy * 1.35) });
      }
    }
    offsets.sort((a, b) => a.d - b.d || a.dy - b.dy || a.dx - b.dx);
    for (const { dx, dy } of offsets) {
      const r: Rect = { x: Math.round(cx + dx), y: Math.round(cy + dy), w, h };
      if (r.y - h / 2 < TOP_Y - NODE_H) continue;
      if (free(r)) return { x: r.x, y: r.y };
    }
    return { x: cx, y: contentBottom + GAP * 2 + h / 2 }; // below everything, never on top
  };

  for (const c of satCodes) {
    const spot = placeSatellite(c.op.x, c.op.y, c.w, c.h);
    c.e.op = { ...(c.e.op as CodeOp), x: spot.x, y: spot.y };
    const card = s.cards.get(c.op.id)!;
    card.x = spot.x; card.y = spot.y;
    placed.set(c.op.id, { x: spot.x, y: spot.y, w: c.w, h: c.h });
  }
  for (const n of newNotes) {
    // note op y is the first line's baseline; convert to/from center for placement
    const centerFromTop = (topY: number) => topY + ((n.lines.length - 1) * NOTE_LINE_H) / 2;
    const hintCy = typeof n.op.y === "number" && Number.isFinite(n.op.y) ? centerFromTop(n.op.y) : undefined;
    const spot = placeSatellite(n.op.x, hintCy, n.w, n.h);
    n.e.op = { ...(n.e.op as NoteOp), x: spot.x, y: Math.round(spot.y - ((n.lines.length - 1) * NOTE_LINE_H) / 2) };
    s.notes.push({ x: spot.x, y: spot.y, w: n.w, h: n.h });
  }

  // ---- pass 6: arrow labels in the emptiest nearby pocket ----
  for (const a of liveArrows) {
    if (!a.op?.label || !a.e) continue;
    const w = labelWidth(a.op.label) + 10, h = 22;
    const path = a.path;
    const scoreAt = (r: Rect, base: number): number => {
      let score = base;
      for (const c of s.cards.values()) if (rectsOverlap(inflate(r, 6), cardObstacle(c))) score += 1000;
      for (const nRect of s.notes) if (rectsOverlap(inflate(r, 4), nRect)) score += 200;
      for (const lr of s.labelRects) if (rectsOverlap(inflate(r, 4), lr)) score += 400;
      if (s.hasTitle && rectsOverlap(r, TITLE_ZONE)) score += 200;
      for (const other of liveArrows) {
        if (other === a) continue;
        for (const q of other.path) if (pointInRect(q, inflate(r, 4))) { score += 30; break; }
      }
      return score;
    };
    let best = { x: 0, y: 0, score: Infinity };
    const consider = (r: Rect, base: number) => {
      const score = scoreAt(r, base);
      if (score < best.score) best = { x: Math.round(r.x), y: Math.round(r.y), score };
    };
    // Sweep along the curve × both sides × growing offsets.
    for (let ti = 0; ti <= 10; ti++) {
      const t = 0.15 + (0.7 * ti) / 10;
      const i = Math.min(path.length - 2, Math.max(1, Math.round(t * (path.length - 1))));
      const p = path[i];
      const dx = path[i + 1].x - path[i - 1].x, dy = path[i + 1].y - path[i - 1].y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      for (const side of [1, -1]) {
        for (const dist of [18, 30, 44, 60, 78]) {
          const r: Rect = { x: p.x + nx * side * dist, y: p.y + ny * side * dist, w, h };
          let base = Math.abs(t - 0.5) * 10 + (dist - 18) * 0.35;
          // Skip positions lying on the own curve away from this anchor.
          for (let k = 0; k < path.length; k++) {
            if (Math.abs(k / (path.length - 1) - t) < 0.12) continue;
            if (pointInRect(path[k], r)) { base += 25; break; }
          }
          consider(r, base);
        }
      }
    }
    // A card overlap in "best" means the whole corridor is packed — spiral
    // out from the midpoint until a card-free pocket exists. A label slightly
    // far from its arrow beats a label printed across a box.
    if (best.score >= 1000) {
      const mid = path[Math.floor(path.length / 2)];
      for (let radius = 40; radius <= 260 && best.score >= 400; radius += 36) {
        for (let step = 0; step < 12; step++) {
          const ang = (step / 12) * Math.PI * 2;
          const r: Rect = { x: mid.x + Math.cos(ang) * radius, y: mid.y + Math.sin(ang) * radius * 0.8, w, h };
          consider(r, 60 + radius * 0.4);
        }
      }
    }
    if (best.score < Infinity) {
      a.e.op = { ...(a.e.op as ArrowOp), labelPos: { x: best.x, y: best.y } };
      s.labelRects.push({ x: best.x, y: best.y, w, h });
    }
  }

  // Thread the resulting board state forward for any post-clear segment.
  return {
    cards: [...s.cards.values()],
    notes: s.notes,
    arrows: [...s.arrows, ...newArrows.filter((a) => !a.e.dropped).map((a) => ({ from: a.op.from, to: a.op.to }))],
    arrowPaths: liveArrows.map((a) => a.path),
    hasTitle: s.hasTitle,
  };
}
