import { lazy, Suspense } from "react";
import { useStore } from "./state/store";
import PreJoin from "./components/PreJoin";
import Room from "./components/Room";
import Ended from "./components/Ended";

// Three.js lives only in the landing chunk — the meeting app stays light.
const Landing = lazy(() => import("./components/Landing"));

export default function App() {
  const phase = useStore((s) => s.phase);
  if (phase === "landing") {
    return (
      <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "#060606" }} />}>
        <Landing />
      </Suspense>
    );
  }
  if (phase === "prejoin") return <PreJoin />;
  if (phase === "ended") return <Ended />;
  return <Room />;
}
