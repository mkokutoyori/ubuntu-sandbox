export interface FortiAggregate {
  members: string[];
  lacpMode: 'static' | 'active' | 'passive';
  lacpSpeed: 'slow' | 'fast';
  algorithm: 'L2' | 'L3' | 'L4';
  minLinks: number;
}

export function defaultAggregate(): FortiAggregate {
  return {
    members: [], lacpMode: 'active', lacpSpeed: 'slow', algorithm: 'L4', minLinks: 1,
  };
}
