import { useEffect, useRef, useState } from "react";
import { session } from "../lib/session";
import type { BoardItem } from "../lib/whiteboard";
import type { Whiteboard } from "../lib/whiteboard";

type Popup = { item: BoardItem; cx: number; cy: number } | null;
type DragState = { item: BoardItem; lastVX: number; lastVY: number; moved: boolean } | null;

export default function BoardCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wbRef = useRef<Whiteboard | null>(null);
  const dragRef = useRef<DragState>(null);
  const [popup, setPopup] = useState<Popup>(null);

  useEffect(() => {
    const wb = session.attachBoard(canvasRef.current!);
    wbRef.current = wb;
    let raf = 0;
    let running = true;
    void document.fonts.ready.then(() => {
      if (!running) return;
      let last = performance.now();
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        wb.update(dt);
        wb.render();
      };
      raf = requestAnimationFrame(loop);
    });
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wb = wbRef.current;
    if (!wb) return;
    const { x: vx, y: vy } = wb.canvasToVirtual(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    const item = wb.hitTest(vx, vy);
    if (item) {
      dragRef.current = { item, lastVX: vx, lastVY: vy, moved: false };
      e.preventDefault();
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const wb = wbRef.current;
    if (!drag || !wb) return;
    const { x: vx, y: vy } = wb.canvasToVirtual(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    const dvx = vx - drag.lastVX;
    const dvy = vy - drag.lastVY;
    if (Math.abs(dvx) > 2 || Math.abs(dvy) > 2) {
      if (!drag.moved) {
        session.onBoardEdit();
        drag.moved = true;
      }
      if (drag.item.id) session.moveBoardItem(drag.item.id, dvx, dvy);
      drag.lastVX = vx;
      drag.lastVY = vy;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const wb = wbRef.current;
    if (drag && !drag.moved && wb) {
      // It was a tap/click — show node popup
      const { x: vx, y: vy } = wb.canvasToVirtual(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      const item = wb.hitTest(vx, vy);
      if (item) setPopup({ item, cx: e.nativeEvent.offsetX, cy: e.nativeEvent.offsetY });
    }
    dragRef.current = null;
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
        onPointerLeave={() => { dragRef.current = null; }}
      />
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
