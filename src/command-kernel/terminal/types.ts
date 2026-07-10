/** Événements que le périphérique remonte vers le shell. */
export interface TerminalEventListener {
  onInterrupt?(): void; // Ctrl+C
  onResize?(columns: number, rows: number): void;
}
