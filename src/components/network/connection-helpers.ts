/**
 * Pure helper functions for connection management on the GUI.
 * Extracted from components for testability.
 */

import type { ConnectionType } from '@/network';

/**
 * Returns a human-readable label for a connection type.
 */
export function getConnectionLabel(type: ConnectionType): string {
  switch (type) {
    case 'ethernet': return 'Ethernet';
    case 'serial': return 'Serial';
    case 'console': return 'Console';
    default: return String(type);
  }
}
