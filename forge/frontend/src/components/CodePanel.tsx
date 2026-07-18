import { useEffect, useRef } from 'react';
import { session } from '../lib/session';
import { useStore } from '../state/store';

export default function CodePanel() {
  const open = useStore((s) => s.codePanelOpen);
  const file = useStore((s) => s.codePanelFile);
  const lines = useStore((s) => s.codePanelLines);
  const startLine = useStore((s) => s.codePanelStartLine);
  const highlight = useStore((s) => s.codePanelHighlight);
  const githubUrl = useStore((s) => s.codePanelGithubUrl);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlight || !panelRef.current) return;
    const el = panelRef.current.querySelector(`[data-line="${highlight.start}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlight]);

  if (!open) return null;
  return (
    <aside id="code-panel">
      <div className="code-panel-head">
        <span className="code-panel-badge">SHARED REPO</span>
        <span className="code-panel-file">{file}</span>
        <div className="code-panel-actions">
          {githubUrl && (
            <a href={githubUrl} target="_blank" rel="noreferrer" className="code-panel-github">
              Open in GitHub ↗
            </a>
          )}
          <button title="Close for everyone" onClick={() => session.closeCodePanel()}>✕</button>
        </div>
      </div>
      <div className="code-panel-body" ref={panelRef}>
        {lines.map((line, i) => {
          const lineNum = startLine + i;
          const hl = highlight != null && lineNum >= highlight.start && lineNum <= highlight.end;
          return (
            <div key={i} data-line={lineNum} className={`code-line${hl ? ' highlighted' : ''}`}>
              <span className="line-num">{lineNum}</span>
              <span className="line-code">{line}</span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
