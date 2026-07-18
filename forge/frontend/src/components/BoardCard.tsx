import { useEffect, useRef } from "react";
import { session } from "../lib/session";

export default function BoardCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wb = session.attachBoard(canvasRef.current!);
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

  return (
    <section id="boardcard">
      <div className="board-chip">✏️ Forge is presenting</div>
      <button id="exitboard" title="Back to grid" onClick={() => session.cancelAgent()}>
        <svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg>
      </button>
      <canvas id="board" ref={canvasRef} />
    </section>
  );
}
