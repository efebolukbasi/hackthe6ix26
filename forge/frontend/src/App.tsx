import { useStore } from "./state/store";
import PreJoin from "./components/PreJoin";
import Room from "./components/Room";
import Ended from "./components/Ended";

export default function App() {
  const phase = useStore((s) => s.phase);
  if (phase === "prejoin") return <PreJoin />;
  if (phase === "ended") return <Ended />;
  return <Room />;
}
