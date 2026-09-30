/*
 * Scenario mesure sur le laboratoire de l'utilisateur : un FortiGate FW1
 * (port2 10.0.20.2/24) sert 10.0.20.1 a .254 (l'interface est DANS la plage),
 * des postes tiennent .1, .3 et .4, un client Windows demande un bail.
 *
 * Mesure avant correctif : le premier `ipconfig /renew` echoue (« unable to
 * contact your DHCP server ») ; le FortiGate offrait SA PROPRE adresse
 * 10.0.20.2, le client l'acceptait puis la declinait (ARP), et le second
 * essai obtenait .5. Avec `set lease-time 3`, le client renouvelait chaque
 * seconde, indefiniment.
 *
 * L'AUTORITE : la reference CLI du depot (official_docs/forti-cli-ref-60.txt,
 * FortiOS 6.0.4, `config system dhcp server`) : « lease-time ... 0 means
 * unlimited. range[300-8640000] » ; RFC 2131 §3.1.2 (un serveur ne propose
 * pas une adresse qu'il porte) et §4.4.5 (T1 = 50 % du bail).
 *
 * Ecrite apres la mesure. 4 des 6 cas tombent avant le correctif (git stash
 * de src/network). Passent des deux cotes : « un serveur ne sert jamais
 * l'adresse d'une de ses interfaces » (avant, le bail servi etait decline par
 * le client et n'atteignait jamais lease-list : temoin structurel), et « un
 * bail de 300 s ne fait pas renouveler chaque seconde » (le laboratoire a 300 s
 * etait deja sain ; il prouve que le renouvellement suit le bail).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { resetCounters, MACAddress, ETHERTYPE_IPV4, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const type = async (device: { executeCommand(c: string): Promise<string> }, lines: readonly string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
};

async function lab(leaseTime: number) {
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  const pc = new WindowsPC('windows-pc', 'PC', -200, 0);
  new Cable('up').connect(sw.getPort('eth0')!, fw.getPort('port2')!);
  new Cable('a').connect(pc.getPort('eth0')!, sw.getPort('eth1')!);
  for (const [index, host] of [1, 3, 4].entries()) {
    const holder = new LinuxPC('linux-pc', `H${host}`, 0, 0);
    new Cable(`h${host}`).connect(holder.getPort('eth0')!, sw.getPort(`eth${2 + index}`)!);
    await type(holder, ['ip link set eth0 up', `ip addr add 10.0.20.${host}/24 dev eth0`]);
  }
  const seen: string[] = [];
  pc.getPort('eth0')!.attachTap(({ direction, frame }) => {
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const udp = (frame.payload as IPv4Packet).payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.payload instanceof DHCPPacket) {
      seen.push(`${direction} ${udp.payload.getMessageType()} ${udp.payload.yiaddr}`);
    }
  });
  const configured = await type(fw, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 10.0.20.2 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set status enable', 'set interface "port2"',
    'set default-gateway 10.0.20.2', 'set netmask 255.255.255.0', `set lease-time ${leaseTime}`, 'set dns-server1 4.4.4.4',
    'config ip-range', 'edit 1', 'set start-ip 10.0.20.1', 'set end-ip 10.0.20.254', 'next', 'end', 'next', 'end',
  ]);
  return { fw, pc, seen, configured };
}

describe('la premiere requete d un client', () => {
  it('reussit du premier coup, et jamais avec l adresse du FortiGate', async () => {
    const { pc, seen } = await lab(604800);
    const output = await pc.executeCommand('ipconfig /renew');
    expect(output).not.toMatch(/unable to contact/i);
    expect(output).toMatch(/IPv4 Address[ .]*: 10\.0\.20\.5/);
    expect(seen.some(line => line.includes('DHCPOFFER 10.0.20.2'))).toBe(false);
    expect(seen.some(line => line.startsWith('out DHCPDECLINE'))).toBe(false);
  });

  it('le client ne decline aucune adresse', async () => {
    const { pc, seen } = await lab(604800);
    await pc.executeCommand('ipconfig /renew');
    expect(seen.filter(line => line.includes('DHCPDECLINE'))).toEqual([]);
  });

  it('WITNESS : lease-list montre le bail du client', async () => {
    const { fw, pc } = await lab(604800);
    await pc.executeCommand('ipconfig /renew');
    expect(await fw.executeCommand('execute dhcp lease-list')).toContain('10.0.20.5');
  });

  it('un serveur ne sert jamais l adresse d aucune de ses interfaces', async () => {
    const { fw, pc } = await lab(604800);
    await pc.executeCommand('ipconfig /renew');
    const leases = await fw.executeCommand('execute dhcp lease-list');
    expect(leases).not.toMatch(/10\.0\.20\.2\s/);
  });
});

describe('lease-time', () => {
  it('3 secondes est refuse : la plage est 300 a 8640000, ou 0', async () => {
    const { fw, configured } = await lab(3);
    expect(configured.join('\n')).toMatch(/range\[300-8640000\]/);
    expect(await fw.executeCommand('show system dhcp server')).not.toMatch(/lease-time 3\b/);
  });

  it('un bail de 300 s ne fait pas renouveler le client chaque seconde', async () => {
    const { pc, seen } = await lab(300);
    await pc.executeCommand('ipconfig /renew');
    seen.length = 0;
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(seen).toEqual([]);
  });
});
