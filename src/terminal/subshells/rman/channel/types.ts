/**
 * Channel types — value-shaped records for the reactive pool.
 */

export type DeviceType = 'DISK' | 'SBT';
export type ChannelState = 'IDLE' | 'BUSY' | 'ERROR' | 'RELEASED';

export interface ChannelConfig {
  readonly id:           string;   // 'ORA_DISK', 'ORA_DISK_1', …
  readonly deviceType:   DeviceType;
  readonly parallelism:  number;
  readonly maxOpenFiles: number;
  readonly sid:          number;
}

export interface ChannelHandle {
  readonly id:          string;
  readonly deviceType:  DeviceType;
  readonly sid:         number;
  readonly allocatedAt: number;
}

export interface ChannelStats {
  readonly totalAllocated: number;
  readonly totalReleased:  number;
  readonly currentBusy:    number;
  readonly errors:         number;
}
