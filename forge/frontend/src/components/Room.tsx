import { useStore } from "../state/store";
import BoardCard from "./BoardCard";
import Tiles from "./Tiles";
import Captions from "./Captions";
import ControlBar from "./ControlBar";
import SidePanel from "./SidePanel";

export default function Room() {
  const presenting = useStore((s) => s.presenting);
  return (
    <main id="room" className={presenting ? "presenting" : ""}>
      <div id="stagewrap">
        <BoardCard />
        <Tiles />
      </div>
      <Captions />
      <ControlBar />
      <SidePanel />
    </main>
  );
}
