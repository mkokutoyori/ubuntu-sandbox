import type { Equipment } from '@/network/equipment/Equipment';

export interface HalfOpenSighting {
  readonly localPort: number;
  readonly remoteIp: string;
  readonly remotePort: number;
}

export function watchHalfOpen(device: Equipment): HalfOpenSighting[] {
  const sightings: HalfOpenSighting[] = [];
  device.getBus().subscribe('tcp.state.changed', (event) => {
    const payload = event.payload;
    if (payload.deviceId !== device.id || payload.newState !== 'syn-received') return;
    sightings.push({
      localPort: payload.localPort, remoteIp: payload.remoteIp, remotePort: payload.remotePort,
    });
  });
  return sightings;
}
