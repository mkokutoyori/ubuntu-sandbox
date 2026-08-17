/**
 * AUDIT — la table de règles ACL du COMMUTATEUR Huawei.
 * Non-régression des huit constats.
 *
 * Ce fichier a commencé comme un banc de preuves ; les constats corrigés,
 * il assoit désormais le comportement JUSTE — un échec est une régression.
 *
 * **Le constat unique dont les huit découlaient : il y avait DEUX
 * magasins.** Un écho verbatim du texte tapé, et les entrées du moteur,
 * alimentés par deux chemins. Ils divergeaient de toutes les façons
 * possibles, et la plus grave était silencieuse : `undo rule 5` retirait
 * la ligne du texte sans toucher au moteur, de sorte qu'une règle
 * supprimée de la configuration continuait de filtrer le trafic.
 *
 * Il n'y en a plus qu'un : le moteur, celui qui filtre pour de bon. Le
 * commutateur partage désormais l'analyse (`HuaweiAclRule`) et le rendu
 * (`HuaweiAclFormat`) du routeur — deux plateformes ne peuvent plus
 * répondre différemment à la même question.
 *
 * Référence des identifiants S-xx : AUDIT-ACL-HUAWEI-SWITCH.md.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv4Packet, IP_PROTO_ICMP, IP_PROTO_TCP } from '@/network/core/types';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';

async function sw(cmds: string[]): Promise<{ s: HuaweiSwitch; out: string[] }> {
  const s = new HuaweiSwitch('switch-huawei', 'SW1', 8);
  const out: string[] = [];
  for (const c of cmds) out.push(await s.executeCommand(c));
  return { s, out };
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

function icmpPkt(src: string, dst: string, icmpType: string, code = 0): IPv4Packet {
  return {
    version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0, totalLength: 28,
    identification: 0, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: { type: 'icmp', icmpType, code },
  } as unknown as IPv4Packet;
}

describe('ACL du commutateur Huawei — non-régression', () => {

  it('S-01 `undo rule` supprime la règle du MOTEUR, pas d\'un texte', async () => {
    const { s, out } = await sw([
      'system-view', 'acl 3000',
      'rule 5 deny tcp source any destination any destination-port eq 22',
      'rule 10 permit ip source any destination any',
      'undo rule 5',
    ]);
    expect(out[4]).toBe('');
    const engine = s.getVaclEngine();
    // La règle a disparu de la vue ET du filtrage — les deux ensemble.
    expect(await s.executeCommand('display this')).not.toContain('rule 5');
    expect(engine.evaluateACL(3000, tcpPkt('1.1.1.1', '2.2.2.2', 22))).toBe('permit');
    expect(engine.findById(3000)!.entries.map(e => e.sequence)).toEqual([10]);
  });

  it('S-01 supprimer une règle absente le dit', async () => {
    const { out } = await sw([
      'system-view', 'acl 3000',
      'rule 5 permit ip source any destination any',
      'undo rule 99',
    ]);
    expect(out[3]).toContain('does not exist');
  });

  it('S-02 le numéro écrit par l\'opérateur est celui qui est gardé', async () => {
    const { s } = await sw([
      'system-view', 'acl 3000',
      'rule 25 permit ip source any destination any',
      'rule 30 deny ip source any destination any',
    ]);
    expect(s.getVaclEngine().findById(3000)!.entries.map(e => e.sequence)).toEqual([25, 30]);
  });

  it('S-02 sans numéro, VRP part du pas (5)', async () => {
    const { s } = await sw([
      'system-view', 'acl 2000',
      'rule permit source 10.0.0.1 0',
      'rule permit source 10.0.0.2 0',
    ]);
    expect(s.getVaclEngine().findById(2000)!.entries.map(e => e.sequence)).toEqual([5, 10]);
  });

  it('S-03 un mot-clé inconnu est refusé, rien n\'est enregistré', async () => {
    const { s, out } = await sw([
      'system-view', 'acl 3000',
      'rule 5 permit tcp source any destination any destinaton-port eq 80',
    ]);
    expect(out[2]).toContain('Unrecognized');
    expect(s.getVaclEngine().findById(3000)?.entries.length).toBe(0);
  });

  it('S-03 une règle correcte reste acceptée, ports compris', async () => {
    const { s, out } = await sw([
      'system-view', 'acl 3000',
      'rule 5 permit tcp source any destination any destination-port eq 80',
    ]);
    expect(out[2]).toBe('');
    expect(s.getVaclEngine().findById(3000)!.entries[0].dstPortSpec).toEqual({ op: 'eq', port: 80 });
  });

  it('S-04 `icmp-type` et `tcp-flag` sont évalués sur le commutateur aussi', async () => {
    const { s } = await sw([
      'system-view', 'acl 3000',
      'rule 5 deny icmp source any destination any icmp-type echo',
      'rule 10 permit ip source any destination any',
    ]);
    const e = s.getVaclEngine();
    expect(e.evaluateACL(3000, icmpPkt('1.1.1.1', '2.2.2.2', 'echo-request'))).toBe('deny');
    expect(e.evaluateACL(3000, icmpPkt('1.1.1.1', '2.2.2.2', 'echo-reply'))).toBe('permit');
  });

  it('S-05 une règle malformée est refusée, et n\'apparaît nulle part', async () => {
    const { s, out } = await sw([
      'system-view', 'acl 2000',
      'rule 5 permit source 999.999.999.999 0.0.0.255',
    ]);
    expect(out[2]).not.toBe('');
    expect(await s.executeCommand('display this')).not.toContain('rule 5');
    expect(s.getVaclEngine().findById(2000)?.entries.length).toBe(0);
  });

  it('S-06 `display acl` lit le pas réel et le numéro stocké', async () => {
    const { s } = await sw([
      'system-view', 'acl 2000', 'step 20',
      'rule permit source 10.0.0.1 0',
      'rule permit source 10.0.0.2 0', 'quit',
    ]);
    const d = await s.executeCommand('display acl 2000');
    expect(d).toContain("ACL's step is 20");
    expect(d).toContain('rule 20 ');
    expect(d).toContain('rule 40 ');
    expect(d).not.toContain('rule 0 ');
  });

  it('S-07 `step` et `description` sont lus par la numérotation et par la vue', async () => {
    const { s } = await sw([
      'system-view', 'acl 2000', 'step 20', 'description filtre invites',
      'rule permit source 10.0.0.0 0.0.0.255', 'quit',
    ]);
    const acl = s.getVaclEngine().findById(2000)!;
    expect(acl.step).toBe(20);
    expect(acl.description).toBe('filtre invites');
    expect(await s.executeCommand('display acl 2000')).toContain('filtre invites');
  });

  it('S-08 `display this` et `display acl` décrivent la MÊME règle', async () => {
    const { s } = await sw([
      'system-view', 'acl 3000',
      'rule 5 permit ip source any destination any',
    ]);
    const config = await s.executeCommand('display this');
    await s.executeCommand('quit');
    const operationnel = await s.executeCommand('display acl 3000');
    // Un seul numéro, celui du magasin unique.
    expect(config).toContain('rule 5 permit ip');
    expect(operationnel).toContain('rule 5 permit ip');
    expect(operationnel).not.toContain('rule 0');
  });

  it('S-08 `display this` rend la forme CONFIGURATION, pas la vue opérationnelle', async () => {
    const { s } = await sw([
      'system-view', 'acl 3000', 'step 15', 'description sortie',
      'rule permit ip source any destination any',
    ]);
    const config = await s.executeCommand('display this');
    expect(config).toContain('acl advanced 3000');
    expect(config).toContain(' step 15');
    expect(config).toContain(' description sortie');
    expect(config).not.toContain('rule(s)');
  });

  it('S-08 `display acl` fonctionne depuis la vue ACL', async () => {
    const { s } = await sw(['system-view', 'acl 2000', 'rule permit source any']);
    const d = await s.executeCommand('display acl 2000');
    expect(d).not.toContain('Unrecognized');
    expect(d).toContain('Basic ACL 2000');
  });

  it('S-09 l\'invite lit le type sur la liste, pas sur un second magasin', async () => {
    const s = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await s.executeCommand('system-view');
    await s.executeCommand('acl 3001');
    expect(s.getPrompt()).toBe('[SW1-acl-adv-3001]');
    await s.executeCommand('quit');
    await s.executeCommand('acl 2001');
    expect(s.getPrompt()).toBe('[SW1-acl-basic-2001]');
  });

  it('S-09 une liste vide existe et s\'affiche, une liste jamais créée non', async () => {
    const { s } = await sw(['system-view', 'acl 2000', 'quit']);
    expect(await s.executeCommand('display acl 2000')).toContain('Basic ACL 2000, 0 rule(s)');
    expect(await s.executeCommand('display acl 2999')).toContain('does not exist');
  });
});
