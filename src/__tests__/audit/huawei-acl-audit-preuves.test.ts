/**
 * AUDIT ACL HUAWEI (VRP) — non-régression des quatorze constats.
 *
 * Ce fichier a commencé comme un banc de preuves : chaque test y assoyait
 * le comportement FAUTIF, pour que le rapport repose sur une mesure et
 * non sur une lecture. Les constats corrigés, il assoit désormais le
 * comportement JUSTE — un échec est une régression.
 *
 * La règle qui les unit est celle du moteur partagé : *un critère que le
 * moteur ne sait pas trancher fait échouer la correspondance*, et un
 * mot-clé qu'on n'évalue pas est refusé à l'analyse plutôt que stocké.
 *
 * Ce qui est PROPRE à VRP, et qu'aucun réglage Cisco ne donne :
 *   — les règles se numérotent par multiples du PAS (5 par défaut) ;
 *   — `traffic-filter` LAISSE PASSER un paquet qu'aucune règle n'apparie.
 * Le second point est vérifié contre un TÉMOIN Cisco monté dans le même
 * test : sans lui, un moteur qui répondrait « permit » à tout le monde
 * serait indiscernable d'une sémantique correctement distinguée.
 *
 * Référence des identifiants H-xx : AUDIT-ACL-HUAWEI.md.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv4Packet, IP_PROTO_ICMP, IP_PROTO_TCP } from '@/network/core/types';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function vrp(cmds: string[]): Promise<{ r: HuaweiRouter; out: string[] }> {
  const r = new HuaweiRouter('AR1');
  const out: string[] = [];
  for (const c of cmds) out.push(await r.executeCommand(c));
  return { r, out };
}

function icmpPkt(src: string, dst: string, icmpType: string, code = 0): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 28,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'icmp', icmpType, code },
  } as unknown as IPv4Packet;
}

function tcpPkt(src: string, dst: string, dport: number, flags?: Record<string, boolean>): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 40,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'tcp', sourcePort: 1234, destinationPort: dport, flags: flags ?? { syn: true } },
  } as unknown as IPv4Packet;
}

describe('ACL Huawei — non-régression des constats d\'audit', () => {

  it('H-01 ACL de base : un mot-clé inconnu est refusé, rien n\'est enregistré', async () => {
    const { r, out } = await vrp([
      'system-view', 'acl 2000',
      'rule 5 permit source 10.0.0.0 0.0.0.255 foubar',
    ]);
    expect(out[2]).toContain('Unrecognized');
    expect(r.getAccessLists().find(a => a.id === 2000)?.entries.length).toBe(0);
  });

  it('H-01 une règle correcte reste acceptée', async () => {
    const { r, out } = await vrp([
      'system-view', 'acl 2000',
      'rule 5 permit source 10.0.0.0 0.0.0.255',
      'rule 10 deny source any',
    ]);
    expect(out[2]).toBe('');
    expect(out[3]).toBe('');
    expect(r.getAccessLists().find(a => a.id === 2000)?.entries.length).toBe(2);
  });

  it('H-02 ACL avancée : un mot-clé inconnu est refusé', async () => {
    const { out } = await vrp([
      'system-view', 'acl 3000',
      'rule 5 permit tcp source any destination any destinaton-port eq 80',
    ]);
    expect(out[2]).toContain('Unrecognized');
  });

  it('H-03 `icmp-type` discrimine enfin le type ICMP', async () => {
    const { r } = await vrp([
      'system-view', 'acl 3000',
      'rule 5 deny icmp source any destination any icmp-type echo',
      'rule 10 permit ip source any destination any',
    ]);
    expect(r.evaluateACLByName('3000', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-request'))).toBe('deny');
    expect(r.evaluateACLByName('3000', icmpPkt('1.1.1.1', '2.2.2.2', 'echo-reply'))).toBe('permit');
  });

  it('H-03 les noms ICMP de VRP sont traduits (host- ≠ port-unreachable)', async () => {
    const { r } = await vrp([
      'system-view', 'acl 3000',
      'rule 5 deny icmp source any destination any icmp-type host-unreachable',
      'rule 10 permit ip source any destination any',
    ]);
    expect(r.evaluateACLByName('3000', icmpPkt('1.1.1.1', '2.2.2.2', 'destination-unreachable', 1))).toBe('deny');
    expect(r.evaluateACLByName('3000', icmpPkt('1.1.1.1', '2.2.2.2', 'destination-unreachable', 3))).toBe('permit');
  });

  it('H-03b `tcp-flag` est évalué', async () => {
    const { r } = await vrp([
      'system-view', 'acl 3000',
      'rule 5 deny tcp source any destination any tcp-flag rst',
      'rule 10 permit ip source any destination any',
    ]);
    expect(r.evaluateACLByName('3000', tcpPkt('1.1.1.1', '2.2.2.2', 80, { syn: true }))).toBe('permit');
    expect(r.evaluateACLByName('3000', tcpPkt('1.1.1.1', '2.2.2.2', 80, { rst: true }))).toBe('deny');
  });

  it('H-03c `vpn-instance` est refusé plutôt que stocké sans effet', async () => {
    const { out } = await vrp([
      'system-view', 'acl 3000',
      'rule 5 permit ip source any destination any vpn-instance CLIENT',
    ]);
    expect(out[2]).toContain('Unrecognized');
  });

  it('H-04 `step` est honoré par la numérotation ET par l\'affichage', async () => {
    const { r } = await vrp([
      'system-view', 'acl 2000', 'step 10',
      'rule permit source 10.0.0.1 0',
      'rule permit source 10.0.0.2 0', 'quit',
    ]);
    const d = await r.executeCommand('display acl 2000');
    expect(d).toContain("ACL's step is 10");
    expect(r.getAccessLists().find(a => a.id === 2000)!.entries.map(e => e.sequence)).toEqual([10, 20]);
  });

  it('H-05 la numérotation VRP part du pas, et un SEUL numéro est affiché', async () => {
    const { r } = await vrp([
      'system-view', 'acl 2000',
      'rule permit source 10.0.0.1 0',
      'rule permit source 10.0.0.2 0', 'quit',
    ]);
    const seqs = r.getAccessLists().find(a => a.id === 2000)!.entries.map(e => e.sequence);
    expect(seqs).toEqual([5, 10]);
    const d = await r.executeCommand('display acl 2000');
    // Le numéro AFFICHÉ est le numéro STOCKÉ — il y en avait deux, différents.
    expect(d).toContain('rule 5 ');
    expect(d).toContain('rule 10 ');
    expect(d).not.toContain('rule 0 ');
  });

  it('H-05 VRP numérote au multiple du pas suivant, pas « le dernier + 10 »', async () => {
    const { r } = await vrp([
      'system-view', 'acl 2000',
      'rule 7 permit source 10.0.0.1 0',
      'rule permit source 10.0.0.2 0',
    ]);
    // règle 7 et pas 5 → la suivante est 10, pas 17
    expect(r.getAccessLists().find(a => a.id === 2000)!.entries.map(e => e.sequence)).toEqual([7, 10]);
  });

  it('H-06 `description` paraît dans la vue ET dans la configuration', async () => {
    const { r } = await vrp([
      'system-view', 'acl 2000', 'description filtre invites',
      'rule permit source 10.0.0.0 0.0.0.255', 'quit',
    ]);
    expect(await r.executeCommand('display acl 2000')).toContain('filtre invites');
    expect(await r.executeCommand('display current-configuration')).toContain('description filtre invites');
  });

  it('H-07 `undo rule` supprime la règle, et dit quand elle n\'existe pas', async () => {
    const { r, out } = await vrp([
      'system-view', 'acl 2000',
      'rule 5 permit source 10.0.0.0 0.0.0.255',
      'rule 10 deny source any',
      'undo rule 5',
      'undo rule 99',
    ]);
    expect(out[4]).toBe('');
    expect(out[5]).toContain('does not exist');
    const e = r.getAccessLists().find(a => a.id === 2000)!.entries;
    expect(e.length).toBe(1);
    expect(e[0].sequence).toBe(10);
  });

  it('H-08 une ACL existante mais vide s\'affiche, avec 0 règle', async () => {
    const { r } = await vrp(['system-view', 'acl 2000', 'quit']);
    const d = await r.executeCommand('display acl 2000');
    expect(d).toContain('Basic ACL 2000, 0 rule(s)');
    expect(d).not.toContain('does not exist');
    // et une liste JAMAIS créée reste inexistante
    expect(await r.executeCommand('display acl 2999')).toContain('does not exist');
  });

  it('H-09 `traffic-filter` accepte une ACL nommée', async () => {
    const { r, out } = await vrp([
      'system-view', 'acl name FILTRE basic', 'rule permit source any', 'quit',
      'interface GigabitEthernet0/0/0',
      'traffic-filter inbound acl name FILTRE',
    ]);
    expect(out[5]).toBe('');
    // VRP range la liaison sous le nom COURT du port.
    expect(r.getInterfaceACL('GE0/0/0', 'in')).toBe('FILTRE');
  });

  it('H-10 `display acl` fonctionne depuis la vue ACL', async () => {
    const { r } = await vrp(['system-view', 'acl 2000', 'rule permit source any']);
    const dansLaVue = await r.executeCommand('display acl 2000');
    expect(dansLaVue).not.toContain('Unrecognized');
    expect(dansLaVue).toContain('Basic ACL 2000');
  });

  it('H-11 le corps d\'une règle avancée nomme son protocole', async () => {
    const { r } = await vrp([
      'system-view', 'acl 3000',
      'rule permit ip source any destination any', 'quit',
    ]);
    expect(await r.executeCommand('display acl 3000')).toMatch(/rule 5 permit ip/);
  });

  it('H-12 VRP laisse passer un paquet non apparié — Cisco le refuse', async () => {
    const { r } = await vrp([
      'system-view', 'acl 3000',
      'rule 5 deny ip source 10.0.0.0 0.0.0.255 destination any',
    ]);
    const horsRegle = tcpPkt('192.168.1.1', '8.8.8.8', 80);
    const dansLaRegle = tcpPkt('10.0.0.5', '8.8.8.8', 80);

    // VRP : `traffic-filter` ne filtre que ce que la liste nomme.
    expect(r._aclEvaluateDataPlane('3000', dansLaRegle)).toBe('deny');
    expect(r._aclEvaluateDataPlane('3000', horsRegle)).toBe('permit');

    // TÉMOIN Cisco, monté dans le même test : sans lui, un moteur qui
    // répondrait « permit » à tout le monde serait indiscernable.
    const c = new CiscoRouter('R');
    for (const cmd of [
      'enable', 'configure terminal',
      'access-list 100 deny ip 10.0.0.0 0.0.0.255 any',
    ]) await c.executeCommand(cmd);
    expect(c._aclEvaluateDataPlane(100, dansLaRegle)).toBe('deny');
    expect(c._aclEvaluateDataPlane(100, horsRegle)).toBe('deny');
  });

  it('H-12 NAT et vty exigent toujours un permit EXPLICITE, sur les deux plateformes', async () => {
    const { r } = await vrp([
      'system-view', 'acl 3000',
      'rule 5 deny ip source 10.0.0.0 0.0.0.255 destination any',
    ]);
    // `evaluateACLByName` sert NAT, vty et IPSec : la règle du service,
    // et non celle de `traffic-filter`.
    expect(r.evaluateACLByName('3000', tcpPkt('192.168.1.1', '8.8.8.8', 80))).toBe('deny');
  });

  it('H-13 la configuration rendue reproduit pas, description et règles', async () => {
    const { r } = await vrp([
      'system-view', 'acl 3000', 'step 20', 'description sortie internet',
      'rule permit tcp source 10.0.0.0 0.0.0.255 destination any destination-port eq 443',
      'quit',
    ]);
    const rc = await r.executeCommand('display current-configuration');
    expect(rc).toContain('acl number 3000');
    expect(rc).toContain(' step 20');
    expect(rc).toContain(' description sortie internet');
    expect(rc).toMatch(/rule 20 permit tcp source 10\.0\.0\.0 0\.0\.0\.255 destination-port eq 443/);
  });
});
