/**
 * ShellSubShellHandle — opaque handle a {@link TerminalPushShellIntent}
 * passes to the runtime so it knows what to nest.
 *
 * Two flavours are supported today:
 *   - { kind: 'subShell', subShell }   — an ISubShell instance (PowerShell,
 *     SqlPlus, RemoteDevice). The terminal session installs it as the active
 *     sub-shell and routes input through its processLine().
 *   - { kind: 'remoteDevice', device, user, label, onPop } — push a
 *     vendor-aware remote device onto the SSH stack. The terminal session
 *     swaps `this.device` to it and the prompt / dispatch follow.
 *
 * Adding new push targets (e.g. a graphical pager, a TUI form) is a matter
 * of extending the union and teaching the runtime how to render it.
 */

import type { ISubShell } from '../subshells/ISubShell';
import type { Equipment } from '@/network';

export interface SubShellPush {
  readonly kind: 'subShell';
  readonly subShell: ISubShell;
  readonly banner?: ReadonlyArray<string>;
  /** Called when the sub-shell exits — used to release SSH session, agents, etc. */
  readonly onPop?: () => void;
}

export interface RemoteDevicePush {
  readonly kind: 'remoteDevice';
  readonly device: Equipment;
  readonly user: string;
  readonly label: string;
  readonly banner?: ReadonlyArray<string>;
  readonly onPop?: () => void;
}

export type ShellSubShellHandle = SubShellPush | RemoteDevicePush;
