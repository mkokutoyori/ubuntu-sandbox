// Polyfill Node.js Buffer for browser environment.
// Domain network entities (EthernetFrame, IPv4Packet, etc.) use Buffer for binary data.
import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
