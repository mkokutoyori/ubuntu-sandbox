import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { vi } from 'vitest';
import { LdpSession } from '@/network/ldp/LdpSession';
import type { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import type { LdpMessage } from '@/network/ldp/LdpMessages';

export interface SentMessage {
  readonly from: string;
  readonly to: string;
  readonly message: LdpMessage;
}

export function recordSentMessages(): SentMessage[] {
  const sent: SentMessage[] = [];
  const original = LdpSession.prototype.send;
  vi.spyOn(LdpSession.prototype, 'send').mockImplementation(function (this: LdpSession, messages: readonly LdpMessage[]) {
    const from = String((this as unknown as { owner: { localId: LdpIdentifier } }).owner.localId.lsrId);
    for (const message of messages) sent.push({ from, to: String(this.peer?.lsrId), message });
    return original.call(this, messages);
  });
  return sent;
}

export async function configure(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

export const lsr = (index: number) => `${index + 101}.${index + 101}.${index + 101}.${index + 101}`;

export interface ChainOptions {
  readonly length: number;
  readonly egress?: boolean;
  readonly setup?: (routers: CiscoRouter[]) => void;
  readonly engines?: (router: CiscoRouter, index: number) => void;
}

export async function ldpChain(clock: VirtualTimeScheduler, options: ChainOptions): Promise<CiscoRouter[]> {
  const routers = Array.from({ length: options.length }, (_, i) => new CiscoRouter(`R${i + 1}`));
  for (let i = 0; i + 1 < routers.length; i++) {
    new Cable(`l${i}`).connect(routers[i].getPort('GigabitEthernet0/1')!, routers[i + 1].getPort('GigabitEthernet0/0')!);
  }
  const egress = options.egress ?? true;
  for (let i = 0; i < routers.length; i++) {
    const previous = i > 0;
    const next = i + 1 < routers.length;
    await configure(routers[i], [
      'interface Loopback0', `ip address ${lsr(i)} 255.255.255.255`, 'exit',
      ...(egress && !next ? ['interface Loopback9', 'ip address 9.9.9.1 255.255.255.0', 'exit'] : []),
      ...(previous ? ['interface GigabitEthernet0/0', `ip address 10.${i - 1}.0.2 255.255.255.0`, 'no shutdown', 'exit',
        `ip route ${lsr(i - 1)} 255.255.255.255 10.${i - 1}.0.1`] : []),
      ...(next ? ['interface GigabitEthernet0/1', `ip address 10.${i}.0.1 255.255.255.0`, 'no shutdown', 'exit',
        `ip route ${lsr(i + 1)} 255.255.255.255 10.${i}.0.2`, `ip route 9.9.9.0 255.255.255.0 10.${i}.0.2`] : []),
    ]);
  }
  options.setup?.(routers);
  routers.forEach((router, i) => options.engines?.(router, i));
  routers.forEach((router, i) => {
    if (i > 0) router.getLdpEngine().enableInterface('GigabitEthernet0/0');
    if (i + 1 < routers.length) router.getLdpEngine().enableInterface('GigabitEthernet0/1');
  });
  clock.advance(60000);
  return routers;
}
