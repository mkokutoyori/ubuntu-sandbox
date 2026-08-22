import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

interface TramesVues { arp: number; icmp: number }

function compterTrames(): { lire(): TramesVues; stop(): void } {
  const vues: TramesVues = { arp: 0, icmp: 0 };
  const stop = getDefaultEventBus().subscribe('port.frame.tx-requested', (e) => {
    const frame = (e.payload as { frame?: { etherType?: number; payload?: unknown } }).frame;
    if (!frame) return;
    if (frame.etherType === 0x0806) { vues.arp++; return; }
    const ip = frame.payload as { protocol?: number } | undefined;
    if (ip?.protocol === 1) vues.icmp++;
  });
  return { lire: () => ({ ...vues }), stop };
}

async function laboratoire() {
  const routeur = new CiscoRouter('R1', 0, 0);
  const squatteur = new LinuxPC('linux-pc', 'SQUAT', -200, 0);
  const client = new LinuxPC('linux-pc', 'CLI', 200, 0);
  new Cable('a').connect(squatteur.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(client.getPort('eth0')!, routeur.getPort('GigabitEthernet0/1')!);

  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp excluded-address 10.0.0.1 10.0.0.9',
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1', 'exit',
    'end']) await run(routeur, c);

  squatteur.configureInterface('eth0',
    new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  return { routeur, squatteur, client };
}

describe('avant d offrir, le serveur envoie un ICMP Echo', () => {
  it('un ICMP part vraiment sur le fil', async () => {
    const { routeur } = await laboratoire();
    const compteur = compterTrames();
    await run(routeur, 'show ip dhcp pool');
    const avant = compteur.lire();

    const libre = (routeur as unknown as {
      isCandidateAddressInUse(ip: IPAddress): boolean;
    }).isCandidateAddressInUse(new IPAddress('10.0.0.10'));

    const apres = compteur.lire();
    compteur.stop();
    expect(libre).toBe(true);
    expect(apres.icmp).toBeGreaterThan(avant.icmp);
  });

  it('une adresse que personne ne porte est libre', async () => {
    const { routeur } = await laboratoire();
    const occupee = (routeur as unknown as {
      isCandidateAddressInUse(ip: IPAddress): boolean;
    }).isCandidateAddressInUse(new IPAddress('10.0.0.77'));
    expect(occupee).toBe(false);
  });

  it('un hote qui repond a l ARP mais FILTRE l ICMP est vu LIBRE', async () => {
    const { routeur, squatteur } = await laboratoire();
    await run(squatteur, 'sudo iptables -A INPUT -p icmp -j DROP');

    const temoin = await run(squatteur, 'sudo iptables -L INPUT');
    expect(temoin).toContain('icmp');

    const occupee = (routeur as unknown as {
      isCandidateAddressInUse(ip: IPAddress): boolean;
    }).isCandidateAddressInUse(new IPAddress('10.0.0.10'));
    expect(occupee).toBe(false);
  });

  it('sans le filtre, le meme hote est vu OCCUPE — c est le temoin', async () => {
    const { routeur } = await laboratoire();
    const occupee = (routeur as unknown as {
      isCandidateAddressInUse(ip: IPAddress): boolean;
    }).isCandidateAddressInUse(new IPAddress('10.0.0.10'));
    expect(occupee).toBe(true);
  });

  it('le bail offert saute l adresse squattee', async () => {
    const { routeur, client } = await laboratoire();
    void routeur;
    await run(client, 'ip link set eth0 up');
    await run(client, 'dhclient eth0');
    const vu = await run(client, 'ip addr show eth0');
    expect(vu).not.toContain('10.0.0.10/');
  });
});
