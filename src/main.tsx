import "./bufferBoot";
import "./simulationClockBoot";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  import('./e2eHandles').then(({ installE2eHandles }) => installE2eHandles());
}

// The incident registry only sees what it is subscribed to, so attach the
// projection at startup rather than on first read — a fault raised before
// anyone opened the incident view still has to be recorded
// (docs/PRD-Pannes.md §6.1).
import('./network/faults').then(({ ensureFaultProjection }) => {
  ensureFaultProjection();
});
