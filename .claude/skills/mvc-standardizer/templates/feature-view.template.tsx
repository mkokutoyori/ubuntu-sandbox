/**
 * TEMPLATE — View (humble React component).
 *
 * Copy to `src/components/.../<Feature>Panel.tsx` and replace `Lldp`/`lldp`.
 *
 * RULES
 *  - Consume VMs through hooks ONLY. Never import `@/network/...` mutable
 *    objects (no Equipment, no engine).
 *  - Keep the component humble: presentation + hook wiring. Any non-trivial
 *    logic (formatting, sorting, derived display) goes to a pure `*-logic.ts`.
 *  - Commands (mutations) go through the store or an explicit action prop,
 *    never by reaching into the domain.
 */

import { useLldpNeighbors, useLldpRuntime } from '@/react/hooks';
// Pure, testable view logic lives next door — see the companion file below.
import { sortNeighborsForDisplay, formatRuntimeBadge } from './lldp-panel-logic';

interface LldpPanelProps {
  readonly deviceId: string;
}

export function LldpPanel({ deviceId }: LldpPanelProps) {
  // VMs only — this component has no idea an LldpEngine exists.
  const neighbors = useLldpNeighbors(deviceId);
  const runtime = useLldpRuntime(deviceId);

  const rows = sortNeighborsForDisplay(neighbors);

  return (
    <div className="lldp-panel">
      <header>{formatRuntimeBadge(runtime)}</header>
      <table>
        <thead>
          <tr><th>Local</th><th>System</th><th>Remote port</th><th>Age</th></tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={`${n.localPort}:${n.chassisId}`}>
              <td>{n.localPort}</td>
              <td>{n.systemName}</td>
              <td>{n.remotePortId}</td>
              <td>{n.ageSeconds}s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * COMPANION FILE — `src/components/.../lldp-panel-logic.ts`
 * Put this in its OWN file. Pure functions, unit-tested under unit/gui/.
 * Modelled on `src/components/network/properties-panel-logic.ts`.
 *
 *   import type { LldpNeighborVM, LldpRuntimeVM } from '@/network/lldp/observables';
 *
 *   export function sortNeighborsForDisplay(
 *     neighbors: ReadonlyArray<LldpNeighborVM>,
 *   ): LldpNeighborVM[] {
 *     return [...neighbors].sort((a, b) => a.localPort.localeCompare(b.localPort));
 *   }
 *
 *   export function formatRuntimeBadge(r: LldpRuntimeVM): string {
 *     if (!r.enabled) return 'LLDP disabled';
 *     return `LLDP — ${r.neighborCount} neighbor(s), tx ${r.txCount} / rx ${r.rxCount}`;
 *   }
 * ────────────────────────────────────────────────────────────────────────── */
