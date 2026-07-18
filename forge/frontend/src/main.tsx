import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// No StrictMode: the session controller owns real-world side effects
// (getUserMedia, AudioContext, speech APIs) that must run exactly once,
// matching the vanilla app's module-load semantics.
createRoot(document.getElementById("root")!).render(<App />);
