import { useEffect, useRef, useState } from "react";
import { session } from "../lib/session";
import type { BoardItem } from "../lib/whiteboard";
import type { Whiteboard } from "../lib/whiteboard";

type Popup = { item: BoardItem; cx: number; cy: number } | null;

// One live gesture at a time: dragging a card, panning the paper, or a
// two-finger pinch (which owns both pointers).
type Gesture =
  | { kind: "drag"; item: BoardItem; lastVX: number; lastVY: number; moved: boolean }
  | { kind: "pan"; lastX: number; lastY: number; moved: boolean }
  | { kind: "pinch" };

export default function BoardCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const wbRef = useRef<Whiteboard | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const [popup, setPopup] = useState<Popup>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [following, setFollowing] = useState(true);

  // Element-local coords from client coords (offsetX is unreliable under CSS
  // transforms and for synthetic events).
  const local = (el: Element, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wb = session.attachBoard(canvas);
    wbRef.current = wb;
    let raf = 0;
    let running = true;
    let lastPct = -1;
    let lastFollow: boolean | null = null;
    void document.fonts.ready.then(() => {
      if (!running) return;
      let last = performance.now();
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        wb.frame(dt);
        if (minimapRef.current) wb.renderMinimap(minimapRef.current, canvas.clientWidth, canvas.clientHeight);
        const pct = Math.round(wb.camera.z * 100);
        if (pct !== lastPct) { lastPct = pct; setZoomPct(pct); }
        if (wb.follow !== lastFollow) { lastFollow = wb.follow; setFollowing(wb.follow); }
      };
      raf = requestAnimationFrame(loop);
    });

    // Native listener: React's synthetic wheel handlers are passive, and
    // pan/zoom must preventDefault or the page scrolls/zooms with it.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const wb2 = wbRef.current;
      if (!wb2) return;
      wb2.setFollow(false);
      setPopup(null);
      const scale = e.deltaMode === 1 ? 16 : 1; // line-mode wheels report lines, not px
      const dx = e.deltaX * scale, dy = e.deltaY * scale;
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch (browsers report it as ctrl+wheel) or explicit zoom.
        const clamped = Math.max(-120, Math.min(120, dy));
        const r = canvas.getBoundingClientRect();
        wb2.camera.zoomAt({ x: e.clientX - r.left, y: e.clientY - r.top }, Math.exp(-clamped * 0.0032));
      } else {
        wb2.camera.panBy(-dx, -dy);
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  const setCursor = (c: string) => {
    if (canvasRef.current) canvasRef.current.style.cursor = c;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wb = wbRef.current;
    if (!wb) return;
    setPopup(null);
    const { x: ox, y: oy } = local(e.currentTarget, e.clientX, e.clientY);
    pointersRef.current.set(e.pointerId, { x: ox, y: oy });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (pointersRef.current.size >= 2) {
      // Second finger down → whatever was happening becomes a pinch.
      if (gestureRef.current?.kind === "drag") wb.setLift(null);
      gestureRef.current = { kind: "pinch" };
      wb.setFollow(false);
      return;
    }
    const { x: vx, y: vy } = wb.canvasToVirtual(ox, oy);
    const item = wb.hitTest(vx, vy);
    if (item) {
      gestureRef.current = { kind: "drag", item, lastVX: vx, lastVY: vy, moved: false };
      if (item.id) wb.setLift(item.id);
      setCursor("grabbing");
    } else {
      gestureRef.current = { kind: "pan", lastX: ox, lastY: oy, moved: false };
      setCursor("grabbing");
    }
    e.preventDefault();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wb = wbRef.current;
    if (!wb) return;
    const { x: ox, y: oy } = local(e.currentTarget, e.clientX, e.clientY);
    const g = gestureRef.current;

    if (g?.kind === "pinch") {
      const pts = pointersRef.current;
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      let other: { x: number; y: number } | null = null;
      for (const [id, p] of pts) if (id !== e.pointerId) other = p;
      if (!other) return;
      const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y) || 1;
      const newDist = Math.hypot(ox - other.x, oy - other.y) || 1;
      const cx = (ox + other.x) / 2, cy = (oy + other.y) / 2;
      const pcx = (prev.x + other.x) / 2, pcy = (prev.y + other.y) / 2;
      wb.camera.zoomAt({ x: cx, y: cy }, newDist / prevDist);
      wb.camera.panBy(cx - pcx, cy - pcy);
      pts.set(e.pointerId, { x: ox, y: oy });
      return;
    }
    // Only track pointers that are actually down — a hover move must never
    // leave a phantom pointer behind (it would turn the next press into a
    // bogus two-finger pinch).
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: ox, y: oy });

    if (g?.kind === "drag") {
      const { x: vx, y: vy } = wb.canvasToVirtual(ox, oy);
      const dvx = vx - g.lastVX;
      const dvy = vy - g.lastVY;
      if (Math.abs(dvx) > 2 || Math.abs(dvy) > 2) {
        if (!g.moved) {
          session.onBoardEdit();
          g.moved = true;
        }
        if (g.item.id) session.moveBoardItem(g.item.id, dvx, dvy);
        g.lastVX = vx;
        g.lastVY = vy;
      }
      return;
    }
    if (g?.kind === "pan") {
      const dx = ox - g.lastX, dy = oy - g.lastY;
      if (!g.moved && Math.hypot(dx, dy) < 2) return;
      g.moved = true;
      wb.setFollow(false);
      wb.camera.panBy(dx, dy);
      g.lastX = ox;
      g.lastY = oy;
      return;
    }

    // No gesture: hover feedback.
    const { x: vx, y: vy } = wb.canvasToVirtual(ox, oy);
    const item = wb.hitTest(vx, vy);
    wb.setHover(item?.id ?? null);
    setCursor(item ? "pointer" : "grab");
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wb = wbRef.current;
    const g = gestureRef.current;
    pointersRef.current.delete(e.pointerId);
    if (g?.kind === "pinch") {
      if (pointersRef.current.size === 1) {
        const [rest] = pointersRef.current.values();
        gestureRef.current = { kind: "pan", lastX: rest.x, lastY: rest.y, moved: true };
      } else if (pointersRef.current.size === 0) {
        gestureRef.current = null;
      }
      return;
    }
    if (g?.kind === "drag" && !g.moved && wb) {
      // It was a tap/click — show node popup
      const { x: ox, y: oy } = local(e.currentTarget, e.clientX, e.clientY);
      const { x: vx, y: vy } = wb.canvasToVirtual(ox, oy);
      const item = wb.hitTest(vx, vy);
      if (item) setPopup({ item, cx: ox, cy: oy });
    }
    wb?.setLift(null);
    gestureRef.current = null;
    setCursor("grab");
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size === 0) gestureRef.current = null;
    wbRef.current?.setLift(null);
    wbRef.current?.setHover(null);
    setCursor("grab");
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const wb = wbRef.current;
    const canvas = canvasRef.current;
    if (!wb || !canvas) return;
    setPopup(null);
    wb.setFollow(false);
    const { x: ox, y: oy } = local(e.currentTarget, e.clientX, e.clientY);
    const world = wb.canvasToVirtual(ox, oy);
    const hit = wb.hitTest(world.x, world.y);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (hit?.bbox) {
      const dx = hit.offset?.dx ?? 0, dy = hit.offset?.dy ?? 0;
      const c = { x: (hit.bbox.minX + hit.bbox.maxX) / 2 + dx, y: (hit.bbox.minY + hit.bbox.maxY) / 2 + dy };
      wb.camera.centerOn(c, cw, ch, Math.max(1.3, wb.camera.z));
    } else {
      wb.camera.centerOn(world, cw, ch, wb.camera.z * 1.6);
    }
  };

  const jumpFromMinimap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wb = wbRef.current;
    const canvas = canvasRef.current;
    if (!wb || !canvas) return;
    wb.setFollow(false);
    const { x: mx, y: my } = local(e.currentTarget, e.clientX, e.clientY);
    const world = wb.minimapToWorld(mx, my);
    wb.camera.centerOn(world, canvas.clientWidth, canvas.clientHeight);
  };

  const handleMinimapDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    jumpFromMinimap(e);
  };

  const handleMinimapMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons & 1) jumpFromMinimap(e);
  };

  const zoomBy = (factor: number) => {
    const wb = wbRef.current;
    const canvas = canvasRef.current;
    if (!wb || !canvas) return;
    wb.setFollow(false);
    wb.camera.zoomStep(factor, canvas.clientWidth, canvas.clientHeight);
  };

  const resetZoom = () => {
    const wb = wbRef.current;
    const canvas = canvasRef.current;
    if (!wb || !canvas) return;
    wb.setFollow(false);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    wb.camera.centerOn(wb.camera.screenToWorld({ x: cw / 2, y: ch / 2 }), cw, ch, 1);
  };

  const handleAskForge = (item: BoardItem) => {
    setPopup(null);
    const op = item.op as { label?: string };
    session.ask("Tell me about " + (op.label ?? "this node"));
  };

  const handleShowInCode = (item: BoardItem) => {
    setPopup(null);
    const op = item.op as { label?: string; attr?: { file: string; startLine?: number; endLine?: number } };
    if (op.attr) session.openCodePanel(op.attr, op.label ?? "this component");
  };

  return (
    <section id="boardcard">
      <div className="board-chip">✏️ Forge is presenting</div>
      <button id="exitboard" title="Back to grid" onClick={() => session.cancelAgent()}>
        <svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg>
      </button>
      <canvas
        id="board"
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerCancel}
        onDoubleClick={handleDoubleClick}
      />
      <div className="board-hud">
        <canvas
          className="board-minimap"
          ref={minimapRef}
          title="Overview — click to jump"
          onPointerDown={handleMinimapDown}
          onPointerMove={handleMinimapMove}
        />
        <div className="board-zoom">
          <button title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
          <button className="zoom-pct" title="Reset to 100%" onClick={resetZoom}>{zoomPct}%</button>
          <button title="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
          <button
            className={`zoom-fit${following ? " active" : ""}`}
            title="Fit drawing & follow the pen"
            onClick={() => wbRef.current?.setFollow(true)}
          >
            <svg viewBox="0 0 24 24">
              <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      {popup && (
        <div
          className="node-popup"
          style={{ left: popup.cx, top: popup.cy }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => handleAskForge(popup.item)}>Ask Forge</button>
          {!!(popup.item.op as { attr?: unknown }).attr && (
            <button onClick={() => handleShowInCode(popup.item)}>Show in code</button>
          )}
          <button className="popup-close" onClick={() => setPopup(null)}>&#x2715;</button>
        </div>
      )}
    </section>
  );
}
