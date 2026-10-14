import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { getAttr } from '@/network/radius/types';
import type { RadiusPacket } from '@/network/radius/types';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

const RADIUS_AUTH = 1812;

export interface Arrivals { count: number; usernames: string[] }

function arrivals(device: CiscoRouter): Arrivals {
  const seen: Arrivals = { count: 0, usernames: [] };
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      const udp = packet?.type === 'ipv4' ? packet.payload as UDPPacket : undefined;
      if (udp?.type === 'udp' && udp.destinationPort === RADIUS_AUTH) {
        seen.count++;
        const name = getAttr(udp.payload as RadiusPacket, 'user-name')?.value;
        if (name !== undefined) seen.usernames.push(String(name));
      }
    });
  }
  return seen;
}

export interface Lab { nas: CiscoRouter; silent: CiscoRouter; live: CiscoRouter; toSilent: Arrivals; toLive: Arrivals }

export async function radiusLab(globalLines: string[]): Promise<Lab> {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const nas = new CiscoRouter('NAS');
  const silent = new CiscoRouter('SILENT');
  const live = new CiscoRouter('LIVE');
  for (const [i, d] of [nas, silent, live].entries()) {
    new Cable(`c${i}`).connect(d.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    d.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(`10.0.0.${i + 1}`), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']) await d.executeCommand(c);
  }
  for (const server of [silent, live]) {
    const agent = server.getRadiusServer();
    agent.start();
    agent.setSharedSecret('secret');
    agent.authorizeClient('10.0.0.1');
    agent.addUser('alice', 'pw');
  }
  silent.getRadiusServer().setEnabled(false);
  live.getRadiusServer().setEnabled(true);
  nas.getRadiusClient().start();
  for (const c of [
    'enable', 'configure terminal', 'aaa new-model',
    'radius-server host 10.0.0.2 auth-port 1812 key secret', 'radius-server host 10.0.0.3 auth-port 1812 key secret',
    'radius-server timeout 1', 'radius-server retransmit 0',
    'aaa group server radius G', 'server name 10.0.0.2', 'server name 10.0.0.3', 'exit',
    'aaa authentication login default group G',
    ...globalLines, 'end',
  ]) await nas.executeCommand(c);
  return { nas, silent, live, toSilent: arrivals(silent), toLive: arrivals(live) };
}

export async function radiusLogin(clock: VirtualTimeScheduler, nas: CiscoRouter, username = 'alice'): Promise<boolean> {
  const outcome = await clock.advanceUntilSettled(nas.getAaaAuthenticator().authenticate(username, 'pw', 'default'));
  return outcome.accepted;
}

