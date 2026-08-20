/**
 * LinuxPC - Linux workstation (desktop / non-root profile).
 *
 * Phase 3: all logic now lives in `LinuxMachine`. `LinuxPC` is a thin
 * shell that provides the PC profile to the parent constructor.
 */

import type { DeviceType } from '../core/types';
import { LinuxMachine } from './LinuxMachine';
import { LINUX_PC_PROFILE } from './linux/LinuxProfile';

export class LinuxPC extends LinuxMachine {
  constructor(a?: DeviceType | string, b?: string | number, c?: number, d?: number) {
    const known: DeviceType[] = ['linux-pc', 'linux-server'];
    let type: DeviceType;
    let name: string;
    let x: number;
    let y: number;
    if (typeof a === 'string' && known.includes(a as DeviceType) && typeof b === 'string') {
      type = a as DeviceType;
      name = b;
      x = (c as number | undefined) ?? 0;
      y = d ?? 0;
    } else if (typeof a === 'string' && typeof b === 'number') {
      type = 'linux-pc';
      name = a;
      x = b;
      y = (c as number | undefined) ?? 0;
    } else {
      type = (a as DeviceType | undefined) ?? 'linux-pc';
      name = (b as string | undefined) ?? 'LinuxPC';
      x = (c as number | undefined) ?? 0;
      y = d ?? 0;
    }
    super(type, name, x, y, LINUX_PC_PROFILE);
  }
}
