import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, SubnetMask } from '@/network/core/types';

export function linuxPair(): { a: LinuxPC; b: LinuxPC } {
  const a = new LinuxPC('A', 0, 0);
  const b = new LinuxPC('B', 0, 0);
  new Cable('c').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { a, b };
}
