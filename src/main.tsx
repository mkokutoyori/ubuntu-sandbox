import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

// Expose the network store + Logger singleton on window for E2E testing
// (dev/test builds only). Prod bundles ship without these handles.
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  import('./store/networkStore').then(({ useNetworkStore }) => {
    (window as unknown as Record<string, unknown>).__networkStore = useNetworkStore;
  });
  import('./network/core/Logger').then(({ Logger }) => {
    (window as unknown as Record<string, unknown>).__logger = Logger;
  });
  import('./network/faults').then(({ getFaultRegistry }) => {
    (window as unknown as Record<string, unknown>).__faults = getFaultRegistry();
  });
}

// The incident registry only sees what it is subscribed to, so attach the
// projection at startup rather than on first read — a fault raised before
// anyone opened the incident view still has to be recorded
// (docs/PRD-Pannes.md §6.1).
import('./network/faults').then(({ ensureFaultProjection }) => {
  ensureFaultProjection();
});
