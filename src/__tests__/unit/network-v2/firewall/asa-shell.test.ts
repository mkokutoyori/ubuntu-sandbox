/**
 * `AsaShell` — la grammaire CLI d'un ASA.
 *
 * BRD-Firewall §26.1 : la couche vendeur livre CINQ artefacts et AUCUN
 * moteur. Ce shell traduit des mots en mutations de magasins ; il ne decide
 * du sort d'aucun paquet, et le garde-fou G1 le verifie mecaniquement.
 *
 * La syntaxe est celle de la documentation Cisco, verifiee et non ecrite de
 * memoire : `object network` avec `host`/`subnet`/`range`, `access-list
 * <nom> extended permit|deny`, `access-group <nom> in interface <if>`,
 * `nat (interieur,exterieur)`. La regle 8.3+ — « you need to specify the
 * REAL IP address, not the NAT translated address » — est portee par le
 * profil, pas par ce shell.
 *
 * Les trois familles de messages de P4 sont eprouvees ici :
 *   1. commande implementee → elle agit ;
 *   2. commande qu'un ASA connait mais que ce build ne simule pas → refus
 *      nommant la brique manquante ;
 *   3. commande inexistante → le message d'IOS pour une commande inconnue.
 *
 * La famille 2 est celle qui compte : sans elle, une commande de
 * durcissement absente disparaitrait en silence, et l'operateur croirait
 * l'avoir posee.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { AsaShell } from '@/network/devices/firewall/vendors/asa/AsaShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

function lab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
  const shell = new AsaShell(fw);
  return { fw, shell };
}

function run(shell: AsaShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = shell.execute(line);
  return last;
}

const ENTER_CONFIG = ['enable', 'configure terminal'];

beforeEach(() => { resetDeviceCounters(); });

describe('AsaShell — modes et invite', () => {
  it('demarre en mode EXEC utilisateur', () => {
    const { shell } = lab();

    expect(shell.getPrompt()).toBe('ASA1>');
  });

  it('`enable` passe en EXEC privilegie', () => {
    const { shell } = lab();
    run(shell, 'enable');

    expect(shell.getPrompt()).toBe('ASA1#');
  });

  it('`configure terminal` passe en configuration', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG);

    expect(shell.getPrompt()).toBe('ASA1(config)#');
  });

  it('`interface` ouvre un sous-mode nomme', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0');

    expect(shell.getPrompt()).toBe('ASA1(config-if)#');
  });

  it('`exit` remonte d\'un niveau', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'exit');

    expect(shell.getPrompt()).toBe('ASA1(config)#');
  });

  it('`end` revient directement en EXEC privilegie', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'end');

    expect(shell.getPrompt()).toBe('ASA1#');
  });

  it('une commande de configuration est refusee en EXEC', () => {
    const { shell } = lab();

    expect(run(shell, 'interface GigabitEthernet0/0')).toContain('Invalid input');
  });
});

describe('AsaShell — interfaces, nameif et niveaux', () => {
  it('`nameif` cree la zone', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'nameif inside');

    expect(fw.getZoneTable().zoneOf('GigabitEthernet0/0')).toBe('inside');
  });

  it('`nameif inside` donne le niveau 100 par defaut — comme un vrai ASA', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'nameif inside');

    expect(fw.getZoneTable().getZone('inside')?.securityLevel).toBe(100);
  });

  it('`nameif outside` donne le niveau 0 par defaut', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/1', 'nameif outside');

    expect(fw.getZoneTable().getZone('outside')?.securityLevel).toBe(0);
  });

  it('`nameif dmz` prend le niveau 0 — « dmz 50 » est une CONVENTION, pas un defaut', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/2', 'nameif dmz');

    expect(fw.getZoneTable().getZone('dmz')?.securityLevel).toBe(0);
  });

  it('`security-level` corrige ensuite ce niveau', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/2',
      'nameif dmz', 'security-level 50');

    expect(fw.getZoneTable().getZone('dmz')?.securityLevel).toBe(50);
  });

  it('`nameif` ANNONCE le niveau qu\'il a choisi, comme le vrai', () => {
    const { shell } = lab();

    const out = run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/1', 'nameif outside');

    expect(out).toBe('INFO: Security level for "outside" set to 0 by default.');
  });

  it('il l\'annonce aussi pour inside, ou le defaut vaut 100', () => {
    const { shell } = lab();

    const out = run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'nameif inside');

    expect(out).toContain('set to 100 by default');
  });

  it('un niveau hors bornes est refuse et ne change rien', () => {
    const { fw, shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/2', 'nameif dmz');

    expect(run(shell, 'security-level 101')).toContain('Invalid input');
    expect(fw.getZoneTable().getZone('dmz')?.securityLevel).toBe(0);
  });

  it('`ip address` configure l\'interface', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0',
      'ip address 192.168.1.1 255.255.255.0');

    expect(fw.getInterfaceTable().get('GigabitEthernet0/0')?.ip).toBe('192.168.1.1');
  });

  it('`shutdown` abaisse l\'interface, `no shutdown` la releve', () => {
    const { fw, shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'shutdown');
    expect(fw.getInterfaceTable().isUp('GigabitEthernet0/0')).toBe(false);

    run(shell, 'no shutdown');

    expect(fw.getInterfaceTable().isUp('GigabitEthernet0/0')).toBe(true);
  });

  it('`shutdown` abaisse le PORT lui-meme, pas la seule ligne de la table', () => {
    const { fw, shell } = lab();
    expect(fw.getPort('GigabitEthernet0/0')!.getIsUp()).toBe(true);

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'shutdown');

    expect(fw.getPort('GigabitEthernet0/0')!.getIsUp()).toBe(false);
  });

  it('refuse une interface inexistante', () => {
    const { shell } = lab();

    expect(run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet9/9'))
      .toContain('Invalid input');
  });
});

describe('AsaShell — objets', () => {
  it('`object network` + `host` cree un objet hote', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'object network SRV_WEB', 'host 192.168.50.10');

    expect(fw.getObjectStore().getAddress('SRV_WEB')?.kind).toBe('host');
  });

  it('`subnet` cree un objet sous-reseau', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'object network LAN', 'subnet 192.168.1.0 255.255.255.0');

    expect(fw.getObjectStore().matchesAddress('LAN', '192.168.1.99')).toBe(true);
    expect(fw.getObjectStore().matchesAddress('LAN', '10.0.0.1')).toBe(false);
  });

  it('`range` cree un objet plage', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'object network POOL',
      'range 192.168.1.10 192.168.1.20');

    expect(fw.getObjectStore().matchesAddress('POOL', '192.168.1.15')).toBe(true);
    expect(fw.getObjectStore().matchesAddress('POOL', '192.168.1.30')).toBe(false);
  });

  it('`object-group network` + `network-object object` groupe des objets', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG,
      'object network A', 'host 10.0.0.1', 'exit',
      'object network B', 'host 10.0.0.2', 'exit',
      'object-group network SERVEURS',
      'network-object object A', 'network-object object B');

    expect(fw.getObjectStore().matchesAddress('SERVEURS', '10.0.0.2')).toBe(true);
  });

  it('l\'invite du sous-mode objet est celle d\'un ASA', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG, 'object network SRV');

    expect(shell.getPrompt()).toBe('ASA1(config-network-object)#');
  });
});

describe('AsaShell — ACL et access-group', () => {
  function withInterfaces(shell: AsaShell) {
    run(shell, ...ENTER_CONFIG,
      'interface GigabitEthernet0/0', 'nameif inside', 'exit',
      'interface GigabitEthernet0/1', 'nameif outside', 'exit');
  }

  it('`access-list ... extended permit` cree une regle', () => {
    const { fw, shell } = lab();
    withInterfaces(shell);

    run(shell, 'access-list OUTSIDE_IN extended permit tcp any any eq 443');

    expect(fw.getPolicyStore().ordered()).toHaveLength(1);
    expect(fw.getPolicyStore().ordered()[0].action).toBe('allow');
  });

  it('`deny` cree une regle de refus', () => {
    const { fw, shell } = lab();
    withInterfaces(shell);

    run(shell, 'access-list OUTSIDE_IN extended deny ip any any');

    expect(fw.getPolicyStore().ordered()[0].action).toBe('deny');
  });

  it('les ACE s\'empilent dans l\'ordre d\'ecriture', () => {
    const { fw, shell } = lab();
    withInterfaces(shell);

    run(shell,
      'access-list L extended permit tcp any any eq 80',
      'access-list L extended deny ip any any');

    const rules = fw.getPolicyStore().ordered();
    expect(rules.map(r => r.action)).toEqual(['allow', 'deny']);
  });

  it('`access-group ... in interface` LIE l\'ACL — et annule le permit implicite', () => {
    const { fw, shell } = lab();
    withInterfaces(shell);
    run(shell, 'access-list OUTSIDE_IN extended permit ip any any');

    run(shell, 'access-group OUTSIDE_IN in interface inside');

    expect(fw.hasPolicyBound('GigabitEthernet0/0')).toBe(true);
  });

  it('`access-group` sur un nom d\'interface inconnu est refuse', () => {
    const { shell } = lab();
    withInterfaces(shell);
    run(shell, 'access-list L extended permit ip any any');

    expect(run(shell, 'access-group L in interface fantome')).toContain('Invalid input');
  });

  it('`same-security-traffic permit inter-interface` pose le drapeau', () => {
    const { fw, shell } = lab();
    run(shell, ...ENTER_CONFIG, 'same-security-traffic permit inter-interface');

    expect(fw.sameSecurityTrafficEnabled('inter-interface')).toBe(true);
  });

  it('sa forme `no` le retire', () => {
    const { fw, shell } = lab();
    run(shell, ...ENTER_CONFIG, 'same-security-traffic permit inter-interface',
      'no same-security-traffic permit inter-interface');

    expect(fw.sameSecurityTrafficEnabled('inter-interface')).toBe(false);
  });
});

describe('AsaShell — vues', () => {
  function configured() {
    const l = lab();
    run(l.shell, ...ENTER_CONFIG,
      'interface GigabitEthernet0/0', 'nameif inside', 'ip address 192.168.1.1 255.255.255.0', 'exit',
      'interface GigabitEthernet0/1', 'nameif outside', 'ip address 203.0.113.1 255.255.255.0', 'exit',
      'end');
    return l;
  }

  it('`show nameif` liste interface, nom et niveau', () => {
    const { shell } = configured();

    const out = run(shell, 'show nameif');

    expect(out).toContain('GigabitEthernet0/0');
    expect(out).toContain('inside');
    expect(out).toContain('100');
    expect(out).toContain('outside');
  });

  it('`show conn` sur une table vide annonce zero', () => {
    const { shell } = configured();

    expect(run(shell, 'show conn')).toContain('0 in use');
  });

  it('`show conn count` rend le nombre', () => {
    const { shell } = configured();

    expect(run(shell, 'show conn count')).toContain('0 in use');
  });

  it('`show running-config` reproduit ce qui a ete tape', () => {
    const { shell } = configured();

    const out = run(shell, 'show running-config');

    expect(out).toContain('interface GigabitEthernet0/0');
    expect(out).toContain(' nameif inside');
    expect(out).toContain(' ip address 192.168.1.1 255.255.255.0');
  });

  it('la configuration rendue porte le niveau', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/2',
      'nameif dmz', 'security-level 50', 'end');

    expect(run(shell, 'show running-config')).toContain(' security-level 50');
  });

  it('elle le porte MEME au defaut — un vrai ASA l\'ecrit toujours', () => {
    const { shell } = configured();

    expect(run(shell, 'show running-config')).toContain(' security-level 0');
  });

  it('elle rend `shutdown` sur une interface abaissee', () => {
    const { shell } = configured();
    run(shell, 'configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end');

    expect(run(shell, 'show running-config')).toContain(' shutdown');
  });

  it('`show version` nomme l\'OS et sa version', () => {
    const { shell } = configured();

    const out = run(shell, 'show version');

    expect(out).toContain('Adaptive Security Appliance');
    expect(out).toContain('9.16(1)');
  });
});

describe('AsaShell — « toute commande inferieure est disponible plus haut »', () => {
  it('un `show` fonctionne DEPUIS la configuration, sans `do` — c\'est un ASA, pas IOS', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'nameif inside', 'exit');

    expect(run(shell, 'show nameif')).toContain('inside');
  });

  it('il fonctionne aussi depuis un SOUS-mode', () => {
    const { shell } = lab();
    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0', 'nameif inside');

    expect(run(shell, 'show nameif')).toContain('inside');
  });

  it('la commande du sous-mode garde la priorite sur celle du dessus', () => {
    const { fw, shell } = lab();

    run(shell, ...ENTER_CONFIG, 'interface GigabitEthernet0/0',
      'ip address 10.9.9.1 255.255.255.0');

    expect(fw.getInterfaceTable().get('GigabitEthernet0/0')?.ip).toBe('10.9.9.1');
  });

  it('l\'inverse n\'est pas vrai : une commande de configuration reste refusee en EXEC', () => {
    const { shell } = lab();

    expect(run(shell, 'enable', 'access-list L extended permit ip any any'))
      .toContain('Invalid input');
  });
});

describe('AsaShell — P4, les trois familles de messages', () => {
  it('famille 3 : une commande INEXISTANTE recoit le message d\'IOS', () => {
    const { shell } = lab();

    expect(run(shell, 'enable', 'zorglub')).toContain('Invalid input detected');
  });

  it('famille 2 : une commande qu\'un ASA CONNAIT mais qui n\'est pas simulee', () => {
    const { shell } = lab();

    const out = run(shell, 'enable', 'show module');

    expect(out).toContain('not implemented in this simulator');
    expect(out).not.toContain('Invalid input');
  });

  it('le refus de famille 2 NOMME la commande', () => {
    const { shell } = lab();

    expect(run(shell, 'enable', 'show module')).toContain('show module');
  });

  it('les deux familles de refus sont DISTINCTES', () => {
    const { shell } = lab();
    run(shell, 'enable');

    const connue = shell.execute('show module');
    const inexistante = shell.execute('zorglub');

    expect(connue).not.toBe(inexistante);
  });

  it('famille 1 : une commande implementee agit et ne rend aucune erreur', () => {
    const { shell } = lab();

    const out = run(shell, ...ENTER_CONFIG, 'same-security-traffic permit inter-interface');

    expect(out).not.toContain('Invalid input');
    expect(out).not.toContain('not implemented');
  });
});
