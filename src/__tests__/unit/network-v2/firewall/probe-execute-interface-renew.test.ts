/**
 * `execute interface dhcpclient-renew` renouvelle un vrai bail.
 *
 * La famille `execute interface` n'existait pas du tout : les trois formes
 * repondaient « unknown action "interface" ». Celle qui compte a un
 * magasin derriere elle depuis toujours — `FirewallDhcp.acquireLease`,
 * appele par le commit d'interface quand `set mode dhcp` — et n'avait
 * simplement aucune porte.
 *
 * Le message rendu est celui de la reference, mot pour mot :
 * « renewing dhcp lease on port1 ».
 *
 * Ce qui manquait pour l'ecrire honnetement : le pare-feu ne savait pas
 * QUELLES interfaces sont clientes DHCP. `applyInterface` recevait
 * l'adresse et le masque, jamais le MODE — le schema n'appelait
 * `acquireDhcpLease` que sur `dhcp` et ne disait rien de la transition
 * inverse, si bien qu'une interface repassee en `static` restait cliente
 * pour toujours. Le mode voyage desormais dans le patch et
 * `setClientMode` suit les deux sens ; sans lui, la commande aurait
 * accepte de renouveler le bail d'une interface a adresse fixe, ce
 * qu'aucune machine reelle ne fait.
 *
 * `dhcp6client-renew` et `pppoe-reconnect` sont REFUSEES en nommant la
 * brique absente — ce build n'a ni client DHCPv6 ni client PPPoE — plutot
 * que rendues comme un succes muet : une commande qui annonce avoir
 * renouvele un bail qui n'existe pas est pire que son absence.
 *
 * Discrimine par `git stash push` : les 8 cas tombent, la famille entiere
 * n'existant pas. Aucun ne passe des deux cotes, et c'est dit plutot que
 * tu — une famille de commandes ajoutee de zero ne peut pas porter de
 * temoin de non-regression sur elle-meme ; celui du DHCP est ailleurs,
 * dans les suites qui font prendre un bail a une interface `mode dhcp`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('wan').connect(fgt.getPort('port1')!, srv.getPort('eth0')!);
  await taper(srv, ['ip addr add 10.0.0.1/24 dev eth0', 'ip link set eth0 up']);

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode dhcp', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'next', 'end',
  ]);
  return { fgt, srv };
}

describe('execute interface', () => {
  it('`dhcpclient-renew` rend le message de la reference', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('execute interface dhcpclient-renew port1'))
      .toBe('renewing dhcp lease on port1');
  });

  it('une interface a adresse fixe n\'est pas cliente', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('execute interface dhcpclient-renew port2'))
      .toContain('port2 is not a DHCP client.');
  });

  it('repasser en `static` retire la qualite de client', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config system interface', 'edit port1', 'set mode static',
      'set ip 10.0.0.9 255.255.255.0', 'next', 'end']);

    expect(await fgt.executeCommand('execute interface dhcpclient-renew port1'))
      .toContain('port1 is not a DHCP client.');
  });

  it('une interface inconnue est refusee', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('execute interface dhcpclient-renew zorglub'))
      .toContain('"zorglub" does not exist.');
  });

  it('sans nom d\'interface, la commande est incomplete', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('execute interface dhcpclient-renew'))
      .toMatch(/interface name/i);
  });

  it('`dhcp6client-renew` et `pppoe-reconnect` nomment la brique absente', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('execute interface dhcp6client-renew port1'))
      .toContain('this build has no DHCPv6 client');
    expect(await fgt.executeCommand('execute interface pppoe-reconnect port1'))
      .toContain('this build has no PPPoE client');
  });

  it('une operation inconnue est refusee', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('execute interface zorglub port1'))
      .toContain('unknown action "interface zorglub"');
  });

  it('`execute interface ?` decrit les trois formes', async () => {
    const { fgt } = await laboratoire();

    const aide = await fgt.executeCommand('execute interface ?');
    expect(aide).toContain('dhcpclient-renew');
    expect(aide).toContain('dhcp6client-renew');
    expect(aide).toContain('pppoe-reconnect');
  });
});
