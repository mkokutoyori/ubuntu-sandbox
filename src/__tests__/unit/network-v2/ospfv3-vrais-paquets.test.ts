/**
 * OSPFv3 traverse le fil.
 *
 * La mesure de depart : OSPFv3 etait le SEUL protocole de ce simulateur
 * a former un etat sans qu'un seul paquet ne circule. `v3FormAdjacency`
 * fabriquait un Hello et appelait `processHello` sur le moteur du
 * voisin, apres avoir compare les configurations des deux routeurs par
 * un parcours de topologie. L'adjacence etait donc reelle au sens du
 * FSM et fictive au sens du reseau : elle se formait entre deux
 * machines qu'aucune trame n'avait jamais reliees.
 *
 * Trois choses manquaient, et aucune n'etait dans OSPF.
 *
 *   1. `enableOSPFv3` n'appelait jamais `setSendCallback`, alors que le
 *      moteur emettait deja ses Hello vers ff02::5 : `sendHello`
 *      sortait par sa premiere ligne.
 *   2. `IPv6DataPlane.processPacket` ne connaissait pas ff02::5 ni
 *      ff02::6, donc un Hello arrive tombait dans le routage et etait
 *      perdu.
 *   3. Rien ne dispatchait l'en-tete suivant 89 (RFC 5340 section 2)
 *      vers le moteur v3.
 *
 * Ce que ce fichier verifie n'est pas « l'adjacence se forme » — elle
 * se formait deja — mais qu'elle se forme PAR LE FIL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Packet } from '@/network/core/types';
import { getDefaultEventBus } from '@/events/EventBus';

const IP_PROTO_OSPF = 89;

interface TrameV3 {
  deviceId: string;
  portName: string;
  dstMAC: string;
  destinationIP: string;
  sourceIP: string;
  hopLimit: number;
  packetType: number;
}

/** Ce qui a REELLEMENT ete emis, lu sur le bus et non sur le moteur. */
function observerLeFil(): { emises: TrameV3[]; recues: TrameV3[] } {
  const emises: TrameV3[] = [];
  const recues: TrameV3[] = [];
  const bus = getDefaultEventBus();

  const lire = (e: { payload: unknown }, dans: TrameV3[]): void => {
    const p = e.payload as {
      deviceId: string; portName: string;
      frame: { dstMAC: { toString(): string }; payload: unknown };
    };
    const ip = p.frame?.payload as IPv6Packet | undefined;
    if (!ip || ip.type !== 'ipv6' || ip.nextHeader !== IP_PROTO_OSPF) return;
    const ospf = ip.payload as { packetType?: number };
    dans.push({
      deviceId: p.deviceId,
      portName: p.portName,
      dstMAC: p.frame.dstMAC.toString(),
      destinationIP: ip.destinationIP.toString(),
      sourceIP: ip.sourceIP.toString(),
      hopLimit: ip.hopLimit,
      packetType: ospf?.packetType ?? -1,
    });
  };

  bus.subscribe('port.frame.tx-requested', (e) => lire(e, emises));
  bus.subscribe('port.frame.received', (e) => lire(e, recues));
  return { emises, recues };
}

async function monterOspfv3(
  r: CiscoRouter, routerId: string, ipv6: string,
  options: { passive?: boolean; hello?: number; ipsec?: boolean } = {},
): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('ipv6 unicast-routing');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand(`ipv6 address ${ipv6}/64`);
  await r.executeCommand('no shutdown');
  if (options.hello) await r.executeCommand(`ipv6 ospf hello-interval ${options.hello}`);
  if (options.ipsec) {
    await r.executeCommand('ipv6 ospf authentication ipsec spi 500 md5 0123456789abcdef0123456789abcdef');
  }
  await r.executeCommand('exit');
  await r.executeCommand('ipv6 router ospf 1');
  await r.executeCommand(`router-id ${routerId}`);
  if (options.passive) await r.executeCommand('passive-interface GigabitEthernet0/0');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ipv6 ospf 1 area 0');
  await r.executeCommand('end');
}

async function laboDeuxRouteurs(
  options: { passiveSurR2?: boolean; ipsecSurR1?: boolean } = {},
): Promise<{ r1: CiscoRouter; r2: CiscoRouter; fil: ReturnType<typeof observerLeFil> }> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  await monterOspfv3(r1, '1.1.1.1', '2001:db8:12::1', { ipsec: options.ipsecSurR1 });
  await monterOspfv3(r2, '1.1.1.2', '2001:db8:12::2', { passive: options.passiveSurR2 });
  new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  // L'observation commence APRES le cablage : ce qui est compte est ce
  // que produit la convergence declenchee par la commande suivante.
  const fil = observerLeFil();
  await r1.executeCommand('show ipv6 ospf neighbor');
  return { r1, r2, fil };
}

function voisins(r: CiscoRouter): string[] {
  const eng = r._getOSPFv3EngineInternal();
  if (!eng) return [];
  return eng.getNeighbors().map((n) => n.routerId);
}

beforeEach(() => {
  // Les remises a zero communes viennent de setupGlobalState.ts.
});

describe('un Hello OSPFv3 circule pour de bon', () => {
  it('des paquets partent, et d\'autres arrivent', async () => {
    const { fil } = await laboDeuxRouteurs();
    expect(fil.emises.length).toBeGreaterThan(0);
    expect(fil.recues.length).toBeGreaterThan(0);
  });

  it('les deux routeurs emettent, et chacun recoit de l\'autre', async () => {
    const { fil } = await laboDeuxRouteurs();
    const emetteurs = new Set(fil.emises.map((t) => t.deviceId));
    const recepteurs = new Set(fil.recues.map((t) => t.deviceId));
    expect(emetteurs.size).toBe(2);
    expect(recepteurs.size).toBe(2);
  });

  it('l\'adjacence atteint Full, et c\'est le paquet qui l\'a faite', async () => {
    const { r1, r2 } = await laboDeuxRouteurs();
    expect(voisins(r1)).toContain('1.1.1.2');
    expect(voisins(r2)).toContain('1.1.1.1');
  });
});

describe('ce que porte le paquet est ce que dit la RFC', () => {
  it('la destination est ff02::5 (RFC 5340 annexe A.1)', async () => {
    const { fil } = await laboDeuxRouteurs();
    // `every` sur un tableau vide est vrai : sans cette ligne le cas
    // passerait alors qu'aucun paquet n'est parti.
    expect(fil.emises.length).toBeGreaterThan(0);
    expect(fil.emises.every((t) => t.destinationIP === 'ff02::5')).toBe(true);
  });

  it('la destination Ethernet est 33:33:00:00:00:05 (RFC 2464 section 7)', async () => {
    const { fil } = await laboDeuxRouteurs();
    const macs = new Set(fil.emises.map((t) => t.dstMAC.toLowerCase()));
    expect([...macs]).toEqual(['33:33:00:00:00:05']);
  });

  it('la limite de sauts vaut 1 : ce paquet ne quitte pas le lien', async () => {
    const { fil } = await laboDeuxRouteurs();
    // `every` sur un tableau vide est vrai : sans cette ligne le cas
    // passerait alors qu'aucun paquet n'est parti.
    expect(fil.emises.length).toBeGreaterThan(0);
    expect(fil.emises.every((t) => t.hopLimit === 1)).toBe(true);
  });

  it('la source est l\'adresse de lien-local (RFC 5340 section 2.5)', async () => {
    const { fil } = await laboDeuxRouteurs();
    expect(fil.emises.length).toBeGreaterThan(0);
    expect(fil.emises.every((t) => t.sourceIP.startsWith('fe80'))).toBe(true);
  });

  it('ce sont des Hello, donc le type 1', async () => {
    const { fil } = await laboDeuxRouteurs();
    // `every` sur un tableau vide est vrai : sans cette ligne le cas
    // passerait alors qu'aucun paquet n'est parti.
    expect(fil.emises.length).toBeGreaterThan(0);
    expect(fil.emises.every((t) => t.packetType === 1)).toBe(true);
  });
});

describe('ce qui empeche un paquet de partir empeche l\'adjacence', () => {
  it('une interface passive n\'emet rien, et n\'est vue de personne', async () => {
    const { r1, r2, fil } = await laboDeuxRouteurs({ passiveSurR2: true });
    const emetteurs = new Set(fil.emises.map((t) => t.deviceId));
    expect(emetteurs.has(r2.getId())).toBe(false);
    // R1 emet toujours ; c'est R2 qui se tait, donc R1 reste sans voisin.
    expect(voisins(r1)).not.toContain('1.1.1.2');
  });

  it('un Hello protege par IPsec d\'un seul cote n\'est pas recevable', async () => {
    // RFC 4552 section 3 : sans association de securite correspondante,
    // le paquet est ecarte avant d'atteindre OSPF. Les paquets PARTENT
    // — c'est bien la reception qui refuse, pas l'emission.
    const { r1, r2, fil } = await laboDeuxRouteurs({ ipsecSurR1: true });
    expect(fil.emises.length).toBeGreaterThan(0);
    expect(voisins(r1)).not.toContain('1.1.1.2');
    expect(voisins(r2)).not.toContain('1.1.1.1');
  });

  it('une interface passive n\'ACCEPTE pas davantage qu\'elle n\'emet', async () => {
    // La regle a deux sens (comportement IOS, et le moteur v2 l'ecrivait
    // deja). Elle etait absente du moteur v3, et invisible tant que rien
    // n'arrivait par le fil : des que le Hello est reel, une interface
    // passive formait un voisin a sens unique.
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await monterOspfv3(r1, '1.1.1.1', '2001:db8:12::1', { passive: true });
    await monterOspfv3(r2, '1.1.1.2', '2001:db8:12::2');
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const fil = observerLeFil();
    await r1.executeCommand('show ipv6 ospf neighbor');

    // R2 emet bien : le Hello ARRIVE sur l'interface passive de R1.
    expect(fil.emises.some((t) => t.deviceId === r2.getId())).toBe(true);
    expect(voisins(r1)).toEqual([]);
  });

  it('des temporisateurs discordants refusent le voisin, et c\'est le Hello qui refuse', async () => {
    // `ipv6 ospf hello-interval` etait refusee par le CLI, et la raison
    // donnee etait juste : rien ne lisait la valeur. Maintenant que
    // l'adjacence se forme sur de vraies trames, `processHello` la lit
    // et un ecart empeche vraiment le voisin.
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await monterOspfv3(r1, '1.1.1.1', '2001:db8:12::1', { hello: 30 });
    await monterOspfv3(r2, '1.1.1.2', '2001:db8:12::2');
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const fil = observerLeFil();
    await r1.executeCommand('show ipv6 ospf neighbor');

    // Les deux emettent : c'est la RECEPTION qui refuse, pas l'emission.
    expect(new Set(fil.emises.map((t) => t.deviceId)).size).toBe(2);
    expect(voisins(r1)).toEqual([]);
    expect(voisins(r2)).toEqual([]);
  });

  it('sans cable, aucun paquet et aucun voisin', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await monterOspfv3(r1, '1.1.1.1', '2001:db8:12::1');
    await monterOspfv3(r2, '1.1.1.2', '2001:db8:12::2');
    const fil = observerLeFil();
    await r1.executeCommand('show ipv6 ospf neighbor');
    expect(fil.emises).toEqual([]);
    expect(voisins(r1)).toEqual([]);
  });
});

describe('la commande qui porte le temporisateur', () => {
  it('sans valeur elle est incomplete, avec une valeur absurde elle est refusee', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(await r.executeCommand('ipv6 ospf hello-interval')).toContain('Incomplete');
    expect(await r.executeCommand('ipv6 ospf hello-interval 0')).toContain('% Invalid value');
    expect(await r.executeCommand('ipv6 ospf dead-interval 40')).toBe('');
  });
});

describe('non-regression', () => {
  it('OSPFv2 continue de converger sur le meme laboratoire', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    for (const [r, ip, rid] of [[r1, '10.0.12.1', '1.1.1.1'], [r2, '10.0.12.2', '1.1.1.2']] as const) {
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      await r.executeCommand('router ospf 1');
      await r.executeCommand(`router-id ${rid}`);
      await r.executeCommand('network 10.0.12.0 0.0.0.255 area 0');
      await r.executeCommand('end');
    }
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const sortie = await r1.executeCommand('show ip ospf neighbor');
    expect(sortie).toContain('1.1.1.2');
  });
});
