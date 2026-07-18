import { useStore } from "../state/store";

export default function Captions() {
  const cap = useStore((s) => s.caption);
  return (
    <div id="captions" className={cap.visible ? "show" : ""}>
      <span id="cap-speaker">{cap.speaker}</span> <span id="cap-text">{cap.text}</span>
    </div>
  );
}
