import { session } from "../lib/session";
import { useStore } from "../state/store";
import type { ForgeTask, ForgeTaskStatus } from "../types";

const KIND_ICON: Record<ForgeTask["kind"], string> = {
  answer: "💬",
  walkthrough: "🧭",
  issue: "🐙",
};

const STATUS_LABEL: Record<ForgeTaskStatus, string> = {
  queued: "queued",
  working: "working",
  ready: "ready",
  presenting: "presenting",
  done: "done",
  cancelled: "cancelled",
  error: "failed",
};

const CANCELLABLE = new Set<ForgeTaskStatus>(["queued", "working", "ready", "presenting"]);

/** Floating registry of everything Forge has queued or running — each row is
 * cancellable while live, and the working row surfaces its tool calls. */
export default function TaskRegistry() {
  const tasks = useStore((s) => s.tasks);
  if (!tasks.length) return null;
  return (
    <div id="task-registry">
      <div className="task-registry-head">Forge tasks</div>
      {tasks.map((t) => (
        <div key={t.id} className={`task-row ${t.status}`}>
          <span className={`task-dot ${t.status}`} />
          <span className="task-kind">{KIND_ICON[t.kind]}</span>
          <span className="task-label" title={t.label}>{t.label}</span>
          <span className="task-status">{STATUS_LABEL[t.status]}</span>
          {CANCELLABLE.has(t.status) && (
            <button
              className="task-cancel"
              title={t.mine ? "Cancel this task" : "Ask to cancel this task"}
              onClick={() => session.cancelTask(t.id)}
            >
              ✕
            </button>
          )}
          {t.status === "working" && t.trace.length > 0 && (
            <div className="task-trace">
              {t.trace.slice(-3).map((line, i) => (
                <div key={i} className="task-trace-line" title={line}>{line}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
