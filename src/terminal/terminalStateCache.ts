/**
 * Terminal State Cache
 *
 * Persists terminal output and command history across React component
 * mount/unmount cycles. This fixes the issue where terminal content
 * disappears when minimizing/restoring or changing tile layouts,
 * because React unmounts and remounts terminal components as they
 * move between different positions in the render tree.
 */

export interface CachedTerminalState {
  lines: Array<{ id: number; text: string; type: string }>;
  history: string[];
  /** Extra state specific to each terminal type */
  extra?: Record<string, unknown>;
}

const cache = new Map<string, CachedTerminalState>();

export function getTerminalState(deviceId: string): CachedTerminalState | undefined {
  return cache.get(deviceId);
}

export function saveTerminalState(deviceId: string, state: CachedTerminalState): void {
  cache.set(deviceId, state);
}

export function clearTerminalState(deviceId: string): void {
  cache.delete(deviceId);
}

export function clearAllTerminalStates(): void {
  cache.clear();
}
