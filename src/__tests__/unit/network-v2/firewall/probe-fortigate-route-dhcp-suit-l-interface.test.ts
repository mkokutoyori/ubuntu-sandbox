/*
 * La route par defaut qu'un FortiGate apprend par DHCP obeit a l'interface qui
 * l'a apprise : `set defaultgw` decide si elle est installee, `set distance`
 * lui donne sa distance administrative, et elle disparait quand l'interface
 * cesse d'etre cliente.
 *
 * Mesure de depart, sur un FortiGate dont port1 est en `mode dhcp` face a un
 * serveur ISC : la route apprise entre dans la table a la distance 1 ; ni
 * `defaultgw` ni `distance` n'existent sur `config system interface` ; une
 * interface repassee en `static` garde sa route par defaut apprise et le
 * client DHCP continue de renouveler a T1 un bail qui n'est plus le sien.
 *
 * Autorites :
 * - le module Ansible `fortios_system_interface`, qui reprend le schema
 *   FortiOS : les attributs `defaultgw` et `distance` de l'interface, ce
 *   dernier decrit comme la distance « for routes learned through PPPoE or
 *   DHCP, lower distance indicates preferred route » ;
 * - la table de routage FortiOS, qui affiche `[distance/metrique]` ;
 * - la reference FortiOS donne `distance` dans 1 a 255 ; les valeurs par
 *   defaut — `defaultgw enable`, `distance 5` — sont celles d'un FortiGate
 *   reel, et ne sont attestees par aucune source atteignable d'ici : les
 *   documentations Fortinet sont bloquees, le module Ansible ne donne ni
 *   defaut ni borne. Le commit le dit.
 *
 * Ecrite a l'aveugle. 9 des 12 cas tombent avant, mesures avec `git stash
 * push -- src/network`. Passent des deux cotes : le TEMOIN (le bail pris sur
 * le fil et la route installee vers la passerelle de l'ISP, qui prouve que le
 * laboratoire est sain) ; « gives the route back when defaultgw is enabled
 * again », qui passe parce que `set defaultgw disable` est refuse avant et
 * que la route n'a donc jamais ete retiree ; et les deux attributs absents d'une interface statique, qui
 * n'existent nulle part avant.
 *
 * Deux constats de plus tombent avec le correctif : une interface en `mode
 * dhcp` dont on edite un autre attribut (`set allowaccess ping`) renvoyait
 * un DHCPREQUEST sur le fil, et une interface repassee en `static` gardait
 * son client — a T1 il renouvelait encore un bail qui n'etait plus le sien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { resetCounters, MACAddress, ETHERTYPE_IPV4, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

const setInterface = (name: string, ...settings: string[]): string[] =>
  ['config system interface', `edit ${name}`, ...settings, 'next', 'end'];

async function wanLab() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const isp = new LinuxServer('linux-server', 'ISP', -200, 0);
  new Cable('wan').connect(isp.getPort('eth0')!, fgt.getPort('port1')!);
  await type(isp, [
    'ip addr add 203.0.113.1/24 dev eth0', 'ip link set eth0 up',
    "printf 'default-lease-time 600;\\nmax-lease-time 600;\\nsubnet 203.0.113.0 netmask 255.255.255.0 {\\n  range 203.0.113.50 203.0.113.60;\\n  option routers 203.0.113.1;\\n}\\n' > /etc/dhcp/dhcpd.conf",
    'systemctl restart isc-dhcp-server',
  ]);
  const requests: string[] = [];
  isp.getPort('eth0')!.attachTap(({ direction, frame }) => {
    if (direction !== 'in' || frame.etherType !== ETHERTYPE_IPV4) return;
    const udp = (frame.payload as IPv4Packet).payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.payload instanceof DHCPPacket) requests.push(udp.payload.getMessageType() ?? '?');
  });
  return { fgt, isp, requests };
}

const routingTable = (fgt: FortiGate): Promise<string> => fgt.executeCommand('get router info routing-table all');
const defaultRoutes = (table: string): string[] => table.split('\n').filter(line => line.includes('0.0.0.0/0'));
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };

describe('the default route a FortiGate learns from DHCP', () => {
  it('reaches the gateway the ISP offered — WITNESS', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp'));

    expect(defaultRoutes(await routingTable(fgt)).join('\n')).toContain('via 203.0.113.1, port1');
  });

  it('is installed at the interface distance, 5 unless told otherwise', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp'));

    expect(defaultRoutes(await routingTable(fgt))).toEqual([expect.stringContaining('[5/0] via 203.0.113.1, port1')]);
  });

  it('follows `set distance` on the interface, even once the lease is held', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp'));
    await type(fgt, setInterface('port1', 'set distance 20'));

    expect(defaultRoutes(await routingTable(fgt))).toEqual([expect.stringContaining('[20/0] via 203.0.113.1, port1')]);
  });

  it('accepts the whole 1 to 255 range and refuses what lies outside it', async () => {
    const { fgt } = await wanLab();
    const [, , , accepted] = await type(fgt, setInterface('port1', 'set mode dhcp', 'set distance 255'));
    const [, , zero] = await type(fgt, setInterface('port1', 'set distance 0'));
    const [, , above] = await type(fgt, setInterface('port1', 'set distance 256'));

    expect(accepted).toBe('');
    expect(zero).not.toBe('');
    expect(above).not.toBe('');
    expect(defaultRoutes(await routingTable(fgt))).toEqual([expect.stringContaining('[255/0]')]);
  });

  it('installs no default route under `set defaultgw disable`, and still takes the address', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp', 'set defaultgw disable'));
    const table = await routingTable(fgt);

    expect(defaultRoutes(table)).toEqual([]);
    expect(table).toContain('203.0.113.0/24 is directly connected, port1');
  });

  it('gives the route back when `defaultgw` is enabled again', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp', 'set defaultgw disable'));
    await type(fgt, setInterface('port1', 'set defaultgw enable'));

    expect(defaultRoutes(await routingTable(fgt)).join('\n')).toContain('via 203.0.113.1, port1');
  });

  it('is preferred to a static default route of higher distance, and loses to one of lower', async () => {
    const { fgt } = await wanLab();
    await type(fgt, [
      ...setInterface('port2', 'set mode static', 'set ip 198.51.100.2 255.255.255.0'),
      'config router static', 'edit 1', 'set dst 0.0.0.0 0.0.0.0', 'set gateway 198.51.100.1',
      'set device port2', 'set distance 10', 'next', 'end',
      ...setInterface('port1', 'set mode dhcp'),
    ]);
    const preferred = defaultRoutes(await routingTable(fgt));
    await type(fgt, setInterface('port1', 'set distance 20'));
    const beaten = defaultRoutes(await routingTable(fgt));

    expect(preferred.join('\n')).toContain('[5/0] via 203.0.113.1, port1');
    expect(preferred.join('\n')).not.toContain('198.51.100.1');
    expect(beaten.join('\n')).toContain('[10/0] via 198.51.100.1, port2');
    expect(beaten.join('\n')).not.toContain('203.0.113.1');
  });

  it('is dropped when the interface stops being a DHCP client', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp'));
    await type(fgt, setInterface('port1', 'set mode static', 'set ip 203.0.113.99 255.255.255.0'));

    expect(defaultRoutes(await routingTable(fgt))).toEqual([]);
  });

  it('puts nothing on the wire when another attribute of a DHCP interface is edited', async () => {
    const { fgt, requests } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp'));
    requests.length = 0;
    await type(fgt, setInterface('port1', 'set allowaccess ping', 'set distance 20'));

    expect(requests).toEqual([]);
  });

  it('stops renewing a lease it no longer holds', async () => {
    const { fgt, requests } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp'));
    await type(fgt, setInterface('port1', 'set mode static', 'set ip 203.0.113.99 255.255.255.0'));
    requests.length = 0;
    clock.advance(1_300_000);
    await settle();

    expect(requests).toEqual([]);
  });
});

describe('the attributes that decide it', () => {
  it('are shown on an interface in dhcp mode', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode dhcp'));
    const shown = await fgt.executeCommand('show full-configuration system interface port1');

    expect(shown).toContain('set defaultgw enable');
    expect(shown).toContain('set distance 5');
  });

  it('are not shown on an interface with a fixed address — WITNESS', async () => {
    const { fgt } = await wanLab();
    await type(fgt, setInterface('port1', 'set mode static', 'set ip 203.0.113.99 255.255.255.0'));
    const shown = await fgt.executeCommand('show full-configuration system interface port1');

    expect(shown).not.toContain('defaultgw');
    expect(shown).not.toContain('distance');
  });
});
