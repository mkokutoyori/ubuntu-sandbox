import type { Port } from '@/network/hardware/Port';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

function pair(leftLabel: string, left: number, rightLabel: string, right: number): string {
  return `  ${padToWidth(`${leftLabel}:`, 26)}${padToWidth(String(left), 3, 'right')},`
    + `  ${padToWidth(`${rightLabel}:`, 26)}${padToWidth(String(right), 3, 'right')}`;
}

function direction(
  sens: 'Input' | 'Output', frames: number, bytes: number,
  unicast: number, multicast: number, broadcast: number,
  discards: number, errors: number,
): string[] {
  return [
    `${sens}:  ${frames} packets, ${bytes} bytes`,
    pair('Unicast', unicast, 'Multicast', multicast),
    `  ${padToWidth('Broadcast:', 26)}${padToWidth(String(broadcast), 3, 'right')},`
      + `  ${padToWidth('Jumbo:', 26)}  -`,
    pair('Discard', discards, 'Total Error', errors),
  ];
}

function utilisation(bitsPerSec: number, port: Port): number {
  const kbps = port.getEffectiveBandwidthKbps();
  if (!kbps) return 0;
  return Math.min(100, Math.round((bitsPerSec / (kbps * 1000)) * 100));
}

/**
 * Le bloc de compteurs de `display interface`, LU sur le port.
 *
 * Les deux vues VRP écrivaient `Input: 0 packets, 0 bytes` en dur —
 * donc une tempête de diffusion, qui est précisément ce que ce bloc
 * existe pour montrer, n'y laissait aucune trace. Le débit vient du
 * même `PortLoad` qu'IOS lit : un seul modèle de charge, deux
 * vocabulaires.
 */
export function vrpInterfaceCounterLines(port: Port): string[] {
  const c = port.getCounters();
  const r = port.getLoadRates();
  return [
    `Last ${r.intervalSec} seconds input rate ${r.inBitsPerSec} bits/sec, `
      + `${r.inPacketsPerSec} packets/sec`,
    `Last ${r.intervalSec} seconds output rate ${r.outBitsPerSec} bits/sec, `
      + `${r.outPacketsPerSec} packets/sec`,
    ...direction('Input', c.framesIn, c.bytesIn,
      c.framesIn - c.broadcastIn - c.multicastIn, c.multicastIn, c.broadcastIn,
      c.dropsIn, c.errorsIn),
    ...direction('Output', c.framesOut, c.bytesOut,
      c.framesOut - c.broadcastOut - c.multicastOut, c.multicastOut, c.broadcastOut,
      c.dropsOut, c.errorsOut),
    `    Input bandwidth utilization  : ${padToWidth(String(utilisation(r.inBitsPerSec, port)), 4, 'right')}%`,
    `    Output bandwidth utilization : ${padToWidth(String(utilisation(r.outBitsPerSec, port)), 4, 'right')}%`,
  ];
}
