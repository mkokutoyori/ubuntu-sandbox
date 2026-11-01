import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import type { IPv6Packet, ICMPv6Packet, NDPRouterAdvertisement } from '@/network/core/types';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

export type Machine = LinuxPC | LinuxServer;

export const rootOn = (device: Machine) => {
  const machine = device as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } };
  return async (command: string): Promise<string> =>
    String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
};

export interface Seen { at: number; destination: string; ra: NDPRouterAdvertisement }

export async function radvdLab(clock: VirtualTimeScheduler, config: string | null, options: { forwarding?: boolean; install?: boolean } = {}) {
  const router = new LinuxServer('linux-server', 'R1');
  const host = new LinuxPC('linux-pc', 'H');
  router.powerOn();
  host.powerOn();
  new Cable('c').connect(router.getPort('eth0')!, host.getPort('eth0')!);
  const onRouter = rootOn(router);
  const onHost = rootOn(host);
  const seen: Seen[] = [];
  host.attachCapture(({ direction, frame }) => {
    if (direction !== 'in') return;
    const ip = frame.payload as IPv6Packet | undefined;
    const icmp = ip?.payload as ICMPv6Packet | undefined;
    if (ip?.type === 'ipv6' && icmp?.icmpType === 'router-advertisement' && icmp.ndp?.ndpType === 'router-advertisement') {
      seen.push({ at: clock.now(), destination: ip.destinationIP.toString(), ra: icmp.ndp });
    }
  });
  if (options.install !== false) await onRouter('apt install -y radvd');
  if (options.forwarding !== false) await onRouter('sysctl -w net.ipv6.conf.all.forwarding=1');
  if (config !== null) await onRouter(`sh -c 'cat > /etc/radvd.conf <<"EOF"\n${config}\nEOF'`);
  return { router, host, onRouter, onHost, seen };
}

