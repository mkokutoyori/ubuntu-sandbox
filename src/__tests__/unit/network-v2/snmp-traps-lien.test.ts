/**
 * `snmp-server enable traps` arme quelque chose.
 *
 * Deux defauts, mesures ensemble parce qu'ils viennent du meme magasin.
 *
 * LA COMMANDE N'EMETTAIT RIEN. `SnmpAgent.sendTrap` est reel et
 * correct, et n'avait pour appelants qu'IP SLA et EEM : aucune
 * notification STANDARD ne quittait jamais la machine, linkDown et
 * linkUp comprises — les plus classiques de toutes. `enabledTraps`
 * etait range, rendu dans la configuration, et lu par personne.
 *
 * LA CONFIGURATION RENDUE NE REPRODUISAIT PAS CE QU'ON AVAIT TAPE.
 * L'analyseur ajoutait CHAQUE suffixe de la ligne, si bien que
 * `enable traps snmp linkdown linkup` ressortait en TROIS lignes —
 * `snmp linkdown linkup`, `linkdown linkup`, `linkup` — dont deux que
 * personne n'a ecrites. Cela depasse l'affichage : la configuration
 * rendue est REJOUEE a l'import d'une topologie, donc elle se
 * multipliait a chaque aller-retour.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, IPv4Packet, UDPPacket } from '@/network/core/types';
import { getDefaultEventBus } from '@/events/EventBus';

const cfg = async (r: CiscoRouter, lignes: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lignes) out.push(await r.executeCommand(l));
  return out;
};

/**
 * Un routeur, un collecteur sur Gi0/0, et un lien a secouer sur Gi0/1.
 *
 * Le lien secoue n'est PAS celui du collecteur : couper la seule route
 * vers le collecteur empecherait la notification d'arriver, ce qui est
 * vrai sur une vraie machine et ne prouverait rien ici.
 */
async function labo(traps: string[] = ['snmp linkdown linkup']): Promise<{
  r: CiscoRouter; pair: LinuxPC; sorties: string[];
}> {
  const r = new CiscoRouter('R1');
  const collecteur = new LinuxPC('COLLECTEUR');
  const pair = new LinuxPC('PAIR');
  collecteur.powerOn(); pair.powerOn();
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, collecteur.getPort('eth0')!);
  new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, pair.getPort('eth0')!);
  collecteur.configureInterface('eth0', new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));

  const sorties = await cfg(r, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'snmp-server community public RO',
    'snmp-server host 10.0.0.50 version 2c public',
    ...traps.map((t) => `snmp-server enable traps ${t}`.trim()),
    'end',
  ]);
  return { r, pair, sorties };
}

/** Les OID de notification reellement emis. */
function observerTraps(): string[] {
  const vus: string[] = [];
  getDefaultEventBus().subscribe('snmp.trap.sent', (e) => {
    vus.push((e.payload as { trapOid: string }).trapOid);
  });
  return vus;
}

/** Les datagrammes UDP reellement partis vers le port des notifications. */
function observerUdp162(): number[] {
  const vus: number[] = [];
  getDefaultEventBus().subscribe('port.frame.tx-requested', (e) => {
    const p = e.payload as { frame: { payload: unknown } };
    const ip = p.frame?.payload as IPv4Packet | undefined;
    if (ip?.type !== 'ipv4') return;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.destinationPort === 162) vus.push(udp.destinationPort);
  });
  return vus;
}

const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';
const LINK_UP = '1.3.6.1.6.3.1.1.5.4';

describe('une interface qui tombe le fait savoir', () => {
  it('shutdown emet linkDown, no shutdown emet linkUp', async () => {
    const { r } = await labo();
    const traps = observerTraps();
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN]);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN, LINK_UP]);
  });

  it('et la notification part vraiment sur le fil, en UDP/162', async () => {
    const { r } = await labo();
    const udp = observerUdp162();
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    expect(udp.length).toBeGreaterThan(0);
  });
});

describe('ce qui n\'est pas arme ne part pas', () => {
  it('sans `enable traps`, rien n\'est emis', async () => {
    const { r } = await labo([]);
    const traps = observerTraps();
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    expect(traps).toEqual([]);
  });

  it('`enable traps snmp linkdown` seul n\'arme pas linkUp', async () => {
    const { r } = await labo(['snmp linkdown']);
    const traps = observerTraps();
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN]);
  });

  it('`enable traps` tout court arme les deux', async () => {
    const { r } = await labo(['']);
    const traps = observerTraps();
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN, LINK_UP]);
  });
});

describe('un etat qui ne change pas ne se notifie pas', () => {
  it('une interface SANS cable n\'emet qu\'un seul linkDown', async () => {
    // Mesure : `shutdown` puis `no shutdown` sur une interface sans
    // cable passent deux fois par « down », le lien restant baisse dans
    // les deux cas. Un vrai routeur n'en notifie qu'un.
    const { r } = await labo();
    const traps = observerTraps();
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/2', 'shutdown', 'end']);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/2', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN]);
  });
});

describe('la configuration reproduit ce qu\'on a tape', () => {
  it('une commande donne une ligne, pas trois', async () => {
    const { r } = await labo(['snmp linkdown linkup']);
    const rc = await r.executeCommand('show running-config');
    expect(rc.split('\n').filter((l) => l.includes('enable traps')))
      .toEqual(['snmp-server enable traps snmp linkdown linkup']);
  });

  it('deux commandes sur le meme type se fondent en une, comme sur IOS', async () => {
    const { r } = await labo(['snmp linkdown', 'snmp linkup']);
    const rc = await r.executeCommand('show running-config');
    expect(rc.split('\n').filter((l) => l.includes('enable traps')))
      .toEqual(['snmp-server enable traps snmp linkdown linkup']);
  });

  it('deux types differents restent deux lignes', async () => {
    const { r } = await labo(['snmp linkdown', 'config']);
    const lignes = (await r.executeCommand('show running-config'))
      .split('\n').filter((l) => l.includes('enable traps'));
    expect(lignes).toEqual([
      'snmp-server enable traps snmp linkdown',
      'snmp-server enable traps config',
    ]);
  });
});
