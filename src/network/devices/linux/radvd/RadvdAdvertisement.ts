import type { ICMPv6Packet, NDPOption } from '@/network/core/types';

export interface RadvdAdvertisementContent {
  curHopLimit: number;
  managed: boolean;
  other: boolean;
  routerLifetime: number;
  preference: number;
  reachableTime: number;
  retransTimer: number;
  options: NDPOption[];
}

export function createICMPv6RouterAdvertisement(content: RadvdAdvertisementContent): ICMPv6Packet {
  return {
    type: 'icmpv6',
    icmpType: 'router-advertisement',
    code: 0,
    ndp: {
      ndpType: 'router-advertisement',
      curHopLimit: content.curHopLimit,
      managedFlag: content.managed,
      otherConfigFlag: content.other,
      routerLifetime: content.routerLifetime,
      routerPreference: content.preference,
      reachableTime: content.reachableTime,
      retransTimer: content.retransTimer,
      options: content.options,
    },
  };
}
