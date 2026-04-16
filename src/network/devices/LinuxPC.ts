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
  constructor(
    type: DeviceType = 'linux-pc',
    name: string = 'LinuxPC',
    x: number = 0,
    y: number = 0,
  ) {
    super(type, name, x, y, LINUX_PC_PROFILE);
  }
}
