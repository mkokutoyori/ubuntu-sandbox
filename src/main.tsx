import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

// Expose the network store on window for E2E testing (dev/test builds only).
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  import('./store/networkStore').then(({ useNetworkStore }) => {
    (window as unknown as Record<string, unknown>).__networkStore = useNetworkStore;
  });
}
