/**
 * Phase 8 : IPsec — et le laboratoire L8.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait, verifie contre
 * la documentation Fortinet AVANT d'ecrire une ligne de produit.
 *
 * Quatre points ne sont pas cosmetiques :
 *
 *   1. **`phase1-interface` CREE une interface.** C'est le point
 *      pedagogique du mode route-based : une fois le tunnel monte, il
 *      n'y a plus de VPN — il y a une interface, une route et une
 *      politique. Un apprenant qui a compris cela a tout compris.
 *   2. **Le moteur IKE est celui du depot**, pas un second. Il a fallu
 *      lui donner un port etroit (`IpsecHost`) au lieu de le lier a
 *      `Router` ; ecrire un deuxieme moteur aurait produit deux reponses
 *      possibles a « ce tunnel est-il monte ? ».
 *   3. **Le groupe Diffie-Hellman est CALCULE.** Depuis le correctif de
 *      socle, un groupe hors de ceux qu'on calcule vraiment est refuse
 *      en nommant la brique absente — et ceux qu'on offre sont ceux dont
 *      les nombres premiers viennent des RFC.
 *   4. **Le mode policy-based est accepte et DECONSEILLE par l'aide.**
 *      Le refuser ferait mentir la CLI sur ce qu'un vrai FortiGate
 *      accepte ; le proposer sans rien dire laisserait un apprenant
 *      choisir le mode herite sans le savoir.
 *
 * Discrimination : `git stash push -- src/network/`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { implementedIkeGroups } from '@/network/ipsec/IkeKeyExchange';
import {
  parseProposal, dhGroupRefusal, renderProposal,
} from '@/network/devices/firewall/vpn/IpsecProposals';
import { IpsecTunnelTable } from '@/network/devices/firewall/vpn/IpsecTunnelTable';
import { transformsOf } from '@/network/devices/firewall/vpn/IpsecProgramming';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  const sh = new FortiShell(fw);
  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static',
    'set ip 198.51.100.2 255.255.255.0', 'next', 'end');
  return { fw, sh };
}

function tunnel(sh: FortiShell, ...extra: string[]): string {
  return run(sh,
    'config vpn ipsec phase1-interface', 'edit "vers_site_b"',
    'set interface "port2"', 'set ike-version 2',
    'set remote-gw 198.51.100.1',
    'set psksecret "SecretPartage2026"',
    'set proposal aes256-sha256', 'set dhgrp 14',
    ...extra, 'next', 'end');
}

function selector(sh: FortiShell, ...extra: string[]): string {
  return run(sh,
    'config vpn ipsec phase2-interface', 'edit "vers_site_b_p2"',
    'set phase1name "vers_site_b"',
    'set proposal aes256-sha256',
    'set src-subnet 192.168.1.0 255.255.255.0',
    'set dst-subnet 192.168.2.0 255.255.255.0',
    ...extra, 'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('`phase1-interface` cree une interface utilisable', () => {
  it('le tunnel est declare et rendu', () => {
    const { fw, sh } = shell();

    tunnel(sh);

    expect(fw.getTunnelTable().getPhase1('vers_site_b')).toBeDefined();
    expect(run(sh, 'show vpn ipsec phase1-interface'))
      .toContain('edit "vers_site_b"');
  });

  it('et une interface du meme nom existe desormais', () => {
    const { fw, sh } = shell();

    tunnel(sh);

    expect(fw.getInterfaceTable().names()).toContain('vers_site_b');
  });

  it('une route statique peut la designer', () => {
    const { fw, sh } = shell();
    tunnel(sh);

    run(sh, 'config router static', 'edit 3',
      'set dst 192.168.2.0 255.255.255.0',
      'set device "vers_site_b"', 'next', 'end');

    expect(fw.getRouteTable().all().some(r => r.iface === 'vers_site_b')).toBe(true);
  });

  it('une politique peut la nommer en `dstintf`', () => {
    const { fw, sh } = shell();
    tunnel(sh);

    run(sh, 'config firewall policy', 'edit 4',
      'set srcintf "port1"', 'set dstintf "vers_site_b"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');

    expect(fw.getPolicyStore().byId('4')).toBeDefined();
  });

  it('supprimer le tunnel retire l`interface', () => {
    const { fw, sh } = shell();
    tunnel(sh);

    run(sh, 'config vpn ipsec phase1-interface', 'delete "vers_site_b"', 'end');

    expect(fw.getInterfaceTable().names()).not.toContain('vers_site_b');
  });

  it('le mode policy-based ne cree PAS d`interface', () => {
    const { fw, sh } = shell();

    run(sh, 'config vpn ipsec phase1', 'edit "herite"',
      'set interface "port2"', 'set remote-gw 198.51.100.1',
      'set psksecret "x"', 'next', 'end');

    expect(fw.getTunnelTable().getPhase1('herite')).toBeDefined();
    expect(fw.getInterfaceTable().names()).not.toContain('herite');
  });

  it('et l`aide le deconseille en le nommant herite', () => {
    const { sh } = shell();

    const aide = run(sh, 'config vpn ipsec ?');

    expect(aide).toContain('phase1');
    expect(aide.toLowerCase()).toContain('legacy');
  });
});

describe('phase 2 : les selecteurs', () => {
  it('le selecteur porte ses deux sous-reseaux', () => {
    const { fw, sh } = shell();
    tunnel(sh);

    selector(sh);

    const declared = fw.getTunnelTable().getPhase2('vers_site_b_p2');
    expect(declared?.sourceSubnet).toBe('192.168.1.0');
    expect(declared?.destinationSubnet).toBe('192.168.2.0');
  });

  it('il est rattache a sa phase 1', () => {
    const { fw, sh } = shell();
    tunnel(sh);
    selector(sh);

    expect(fw.getTunnelTable().selectorsOf('vers_site_b')).toHaveLength(1);
  });

  it('supprimer la phase 1 emporte ses selecteurs', () => {
    const { fw, sh } = shell();
    tunnel(sh);
    selector(sh);

    run(sh, 'config vpn ipsec phase1-interface', 'delete "vers_site_b"', 'end');

    expect(fw.getTunnelTable().getPhase2('vers_site_b_p2')).toBeUndefined();
  });

  it('`pfs` est actif par defaut, comme sur un vrai FortiGate', () => {
    const { fw, sh } = shell();
    tunnel(sh);
    selector(sh);

    expect(fw.getTunnelTable().getPhase2('vers_site_b_p2')?.pfs).toBe(true);
  });
});

describe('les propositions decident de ce qui est accepte', () => {
  it.each(['aes128-sha256', 'aes256-sha256', 'aes256-sha1', 'aes128gcm-sha256'])(
    '`%s` est acceptee', (word) => {
      expect(parseProposal(word).ok).toBe(true);
    });

  it('`3des-sha1` est acceptee — 3DES se dechiffre desormais', () => {
    expect(parseProposal('3des-sha1').ok).toBe(true);
  });

  it('`chacha20poly1305-sha256` est refusee en nommant la brique absente', () => {
    const verdict = parseProposal('chacha20poly1305-sha256');

    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason).toContain('not implemented');
  });

  it('un chiffrement inconnu est refuse en listant ce qui existe', () => {
    const verdict = parseProposal('kuznyechik-sha256');

    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason).toContain('aes256');
  });

  it('un mot sans tiret n`est pas une proposition', () => {
    expect(parseProposal('aes256').ok).toBe(false);
  });

  it('la proposition se rend telle qu`elle a ete ecrite', () => {
    const verdict = parseProposal('aes256-sha512');

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(renderProposal(verdict.proposal)).toBe('aes256-sha512');
  });

  it('une proposition devient un jeu de transformations ESP reel', () => {
    expect(transformsOf([{ cipher: 'aes256', integrity: 'sha256' }]))
      .toEqual(['esp-256-aes', 'esp-sha256-hmac']);
  });
});

describe('les groupes Diffie-Hellman offerts sont ceux qu`on calcule', () => {
  it('le groupe 14 est offert — c`est celui de tous les laboratoires', () => {
    expect(implementedIkeGroups()).toContain(14);
  });

  it.each([1, 2, 5, 14, 19, 31])('le groupe %i ne provoque aucun refus', (group) => {
    expect(dhGroupRefusal(group)).toBeNull();
  });

  it('un groupe sans implementation est refuse en nommant ce qui existe', () => {
    const refus = dhGroupRefusal(18);

    expect(refus).not.toBeNull();
    expect(refus).toContain('RFC 3526');
    expect(refus).toContain('14');
  });

  it('`set dhgrp ?` n`annonce que les groupes calculables', () => {
    const { sh } = shell();
    run(sh, 'config vpn ipsec phase1-interface', 'edit "T"');

    const aide = run(sh, 'set dhgrp ?');

    expect(aide).toContain('14');
    expect(aide).not.toMatch(/^18\s/m);
  });

  it('un groupe non calculable est refuse par la CLI', () => {
    const { sh } = shell();

    const dit = run(sh, 'config vpn ipsec phase1-interface', 'edit "T"',
      'set dhgrp 18');

    expect(dit).toContain('Command fail');
  });
});

describe('`diagnose vpn tunnel list` lit l`etat reel', () => {
  it('sans tunnel, il ne rend rien', () => {
    const { sh } = shell();

    expect(run(sh, 'diagnose vpn tunnel list')).toBe('');
  });

  it('avec un tunnel, il rend le format de FortiOS', () => {
    const { sh } = shell();
    tunnel(sh);
    selector(sh);

    const vu = run(sh, 'diagnose vpn tunnel list');

    expect(vu).toContain('name=vers_site_b ver=2 serial=');
    expect(vu).toContain('bound_if=port2');
    expect(vu).toContain('proxyid_num=1');
    expect(vu).toContain('stat: rxp=0 txp=0 rxb=0 txb=0');
  });

  it('il annonce l`absence de SA tant que le tunnel n`est pas monte', () => {
    const { sh } = shell();
    tunnel(sh);
    selector(sh);

    expect(run(sh, 'diagnose vpn tunnel list'))
      .toContain('no security association');
  });

  it('il rend les sous-reseaux du selecteur', () => {
    const { sh } = shell();
    tunnel(sh);
    selector(sh);

    const vu = run(sh, 'diagnose vpn tunnel list');

    expect(vu).toContain('src: 0:192.168.1.0/255.255.255.0:0');
    expect(vu).toContain('dst: 0:192.168.2.0/255.255.255.0:0');
  });

  it('le resume nomme le tunnel, sa passerelle et son etat', () => {
    const { sh } = shell();
    tunnel(sh);

    expect(run(sh, 'diagnose vpn tunnel summary'))
      .toContain('vers_site_b\t198.51.100.1\tdown');
  });

  it('les compteurs sont ceux de la table, pas des constantes', () => {
    const table = new IpsecTunnelTable({ now: () => 1000 });
    table.setPhase1({
      name: 'T', boundInterface: 'port2', ikeVersion: 2, type: 'static',
      remoteGateway: '198.51.100.1', proposals: [], dhGroups: [14],
      presharedKey: 'x', keyLifeSeconds: 86400, dpd: 'on-demand',
      authMethod: 'psk', certificate: '',
      natTraversal: 'enable', policyBased: false,
    });

    table.recordTraffic('T', 'out', 84);
    table.recordTraffic('T', 'in', 84);

    expect(table.stateOf('T')?.counters).toEqual({
      receivedPackets: 1, sentPackets: 1, receivedBytes: 84, sentBytes: 84,
    });
  });
});

describe('le moteur IKE du depot est celui qui sert', () => {
  it('le pare-feu en porte un', () => {
    const { fw } = shell();

    expect(fw.getIpsecEngine()).toBeDefined();
    expect(fw.getIpsecEngine().isRunning()).toBe(true);
  });

  it('declarer un tunnel programme une politique ISAKMP reelle', () => {
    const { fw, sh } = shell();

    tunnel(sh);

    expect(fw.getIpsecEngine().getISAKMPPolicies().length).toBeGreaterThan(0);
  });

  it('et un jeu de transformations porte le nom du tunnel', () => {
    const { fw, sh } = shell();
    tunnel(sh);
    selector(sh);

    expect(fw.getIpsecEngine().getTransformSets()
      .some(t => t.name === 'TS_vers_site_b')).toBe(true);
  });

  it('un tunnel jamais negocie n`est pas monte', () => {
    const { fw, sh } = shell();
    tunnel(sh);
    selector(sh);

    expect(fw.bringUpIpsecTunnel('vers_site_b')).toBe(false);
    expect(fw.getTunnelTable().stateOf('vers_site_b')?.status).toBe('down');
  });

  it('monter un tunnel qui n`existe pas repond non', () => {
    const { fw } = shell();

    expect(fw.bringUpIpsecTunnel('inconnu')).toBe(false);
  });
});
