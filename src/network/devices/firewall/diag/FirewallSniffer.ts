import type { CapturedFrame } from './PacketCapture';
import type { SnifferMatcher } from './SnifferFilter';

export interface SnifferSelection {
  readonly iface: string;
  readonly matches: SnifferMatcher;
  readonly count: number;
}

export interface SnifferSource {
  observe(listener: (entry: CapturedFrame) => void): () => void;
}

export interface SnifferRun {
  readonly wanted: number;
  onFrame(listener: (entry: CapturedFrame) => void): () => void;
}

export function beginSniffer(
  source: SnifferSource, selection: SnifferSelection,
): SnifferRun {
  return {
    wanted: selection.count,
    onFrame: (listener) => source.observe((entry) => {
      if (selection.iface !== 'any' && entry.iface !== selection.iface) return;
      if (!selection.matches(entry)) return;
      listener(entry);
    }),
  };
}
