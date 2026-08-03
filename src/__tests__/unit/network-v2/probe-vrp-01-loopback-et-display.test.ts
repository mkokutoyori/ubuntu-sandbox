/**
 * Sondes — la LoopBack d'un switch VRP et les `display` qui manquaient.
 *
 * Priorité 7 de `docs/audit/11-transcripts-debug-2026-08.md`. Mesuré sur
 * un `HuaweiSwitch` et un `HuaweiRouter` neufs avant d'écrire une ligne,
 * ce qui a montré que le ROUTEUR faisait déjà tout correctement — `ip
 * address` sur LoopBack0, `display ip interface LoopBack0`, la ligne dans
 * `display ip interface brief`. Le manque était **côté switch
 * uniquement** : son handler `ip address` était câblé en dur sur Vlanif
 * et refusait tout le reste (« only valid on Vlanif interfaces »), ce qui
 * faisait échouer en cascade tout ce qui suivait dans la section.
 *
 * Ce que ce fichier vérifie tient en une phrase : **une LoopBack est une
 * interface, pas un affichage**. Elle stocke une adresse, elle apparaît
 * dans les trois vues, et surtout elle RÉPOND — un `ping` vers elle,
 * arrivé par n'importe quel Vlanif, est traité localement. C'est le seul
 * cas qui distingue une vraie interface d'une ligne de texte, et c'est
 * pour ça que `SwitchSvi.isOwnAddress()` unifie « SVI ou LoopBack » en un
 * seul endroit plutôt que de laisser trois appelants répondre chacun à sa
 * façon.
 *
 * Deux défauts PRÉEXISTANTS ont été trouvés en mesurant, pas en relisant :
 *
 *  - `SwitchSecurityService.configureDhcpSnooping` testait `snooping
 *    enable` AVANT `snooping enable vlan <n>`, si bien que la branche
 *    `vlan` était inatteignable : `dhcp snooping enable vlan 10` posait
 *    le drapeau global et n'enregistrait jamais le VLAN. Personne ne
 *    l'avait vu parce que rien ne lisait cet état — `display dhcp
 *    snooping` n'existait pas.
 *  - `display port` et `display dhcp snooping` répondaient « Incomplete
 *    command » alors que l'état existait dans les deux cas.
 *  - `dhcp snooping trusted interface <if>` en vue SYSTÈME était refusé,
 *    si bien que `SwitchSecurityService.dhcpSnoopingTrust` n'était
 *    atteignable par aucun chemin. Les deux orthographes écrivent
 *    maintenant dans le magasin qui APPLIQUE, pas seulement dans celui
 *    qui décrit — accepter la commande sans l'appliquer serait pire que
 *    la refuser.
 *
 * Restent délibérément refusés, et c'est la bonne réponse : `display
 * ospfv3`, `ipv6 enable`, `ipv6 address` et `dhcpv6 server` sur un
 * switch. `HuaweiSwitchShell` ne contient AUCUNE occurrence d'IPv6 et
 * `Switch` n'a pas de pile v6 — les accepter demanderait de construire
 * cette pile, ce qui est un chantier distinct, pas une extension bornée
 * de ce lot. Les accepter sans pile derrière serait une promesse non
 * tenue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function switchEnSysteme(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
  await sw.executeCommand('system-view');
  return sw;
}

async function avecLoopback(sw: HuaweiSwitch, n = 0, ip = '1.1.1.1'): Promise<void> {
  await sw.executeCommand(`interface LoopBack${n}`);
  await sw.executeCommand(`ip address ${ip} 32`);
  await sw.executeCommand('quit');
}

describe('Scénario 1 — `ip address` sur LoopBack est accepté', () => {
  it('le refus « only valid on Vlanif » a disparu', async () => {
    const sw = await switchEnSysteme();
    await sw.executeCommand('interface LoopBack0');
    expect(await sw.executeCommand('ip address 1.1.1.1 32')).toBe('');
  });

  it('un port physique reste refusé, et le message nomme les deux formes', async () => {
    const sw = await switchEnSysteme();
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    const out = await sw.executeCommand('ip address 1.1.1.1 24');
    expect(out).toContain('only valid on Vlanif and LoopBack');
  });

  it('une adresse invalide est refusée sur LoopBack comme ailleurs', async () => {
    const sw = await switchEnSysteme();
    await sw.executeCommand('interface LoopBack0');
    expect(await sw.executeCommand('ip address 999.1.1.1 32')).toContain('Invalid IP address');
  });

  it('`undo ip address` retire l\'adresse sans supprimer l\'interface', async () => {
    const sw = await switchEnSysteme();
    await avecLoopback(sw);
    await sw.executeCommand('interface LoopBack0');
    await sw.executeCommand('undo ip address');
    await sw.executeCommand('quit');
    expect(sw.hasLoopback('LoopBack0')).toBe(true);
    expect(sw.getLoopback('LoopBack0')?.ip).toBeUndefined();
  });
});

describe('Scénario 2 — la LoopBack apparaît dans les trois vues', () => {
  it('`display ip interface brief` la liste, up des deux côtés', async () => {
    const sw = await switchEnSysteme();
    await avecLoopback(sw);
    const out = await sw.executeCommand('display ip interface brief');
    const ligne = out.split('\n').find((l) => l.startsWith('LoopBack0'));
    expect(ligne).toBeTruthy();
    expect(ligne).toContain('1.1.1.1/32');
    expect(ligne).toContain('up');
  });

  it('`display ip interface LoopBack0` rend le bloc long', async () => {
    const sw = await switchEnSysteme();
    await avecLoopback(sw);
    const out = await sw.executeCommand('display ip interface LoopBack0');
    expect(out).toContain('LoopBack0 current state : UP');
    expect(out).toContain('Internet Address is 1.1.1.1/32');
  });

  it('`display interface LoopBack0` mène au même bloc', async () => {
    const sw = await switchEnSysteme();
    await avecLoopback(sw);
    expect(await sw.executeCommand('display interface LoopBack0'))
      .toBe(await sw.executeCommand('display ip interface LoopBack0'));
  });

  it('une LoopBack inexistante est refusée, pas inventée', async () => {
    const sw = await switchEnSysteme();
    expect(await sw.executeCommand('display ip interface LoopBack9'))
      .toContain("Wrong parameter found at '^' position");
  });

  it('`display ip interface Vlanif1` existe aussi maintenant', async () => {
    const sw = await switchEnSysteme();
    await sw.executeCommand('interface Vlanif1');
    await sw.executeCommand('ip address 10.0.0.1 24');
    await sw.executeCommand('quit');
    const out = await sw.executeCommand('display ip interface Vlanif1');
    expect(out).toContain('Vlanif1 current state');
    expect(out).toContain('Internet Address is 10.0.0.1/24');
  });
});

describe('Scénario 3 — une LoopBack est une interface, pas un affichage', () => {
  it('son adresse est reconnue comme locale par le plan L3', async () => {
    const sw = await switchEnSysteme();
    await avecLoopback(sw);
    // C'est ce que le plan SVI consulte pour décider « pour nous » —
    // sans ça, un ping vers la loopback serait routé au lieu d'être
    // répondu, et l'interface ne serait qu'une ligne de texte.
    const locales = sw.getLoopbacks().map((l) => l.ip?.toString());
    expect(locales).toContain('1.1.1.1');
  });

  it('plusieurs LoopBack coexistent et se trient numériquement', async () => {
    const sw = await switchEnSysteme();
    await avecLoopback(sw, 10, '10.10.10.10');
    await avecLoopback(sw, 2, '2.2.2.2');
    await avecLoopback(sw, 0, '1.1.1.1');
    expect(sw.getLoopbacks().map((l) => l.name))
      .toEqual(['LoopBack0', 'LoopBack2', 'LoopBack10']);
  });

  it('le magasin est par équipement', async () => {
    const sw1 = await switchEnSysteme();
    await avecLoopback(sw1);
    EquipmentRegistry.getInstance();
    const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 24);
    expect(sw2.hasLoopback('LoopBack0')).toBe(false);
    expect(sw1.hasLoopback('LoopBack0')).toBe(true);
  });
});

describe('Scénario 4 — `display port` et `display dhcp snooping`', () => {
  it('`display port` seul répond, il ne dit plus « Incomplete »', async () => {
    const sw = await switchEnSysteme();
    const out = await sw.executeCommand('display port');
    expect(out).not.toContain('Incomplete');
    expect(out.split('\n')[0]).toContain('Interface');
    expect(out).toContain('GigabitEthernet0/0/1');
  });

  it('`display dhcp snooping` lit l\'état global réel', async () => {
    const sw = await switchEnSysteme();
    expect(await sw.executeCommand('display dhcp snooping'))
      .toContain('DHCP snooping                          : Disable');
    await sw.executeCommand('dhcp snooping enable');
    expect(await sw.executeCommand('display dhcp snooping'))
      .toContain('DHCP snooping                          : Enable');
  });

  it('`enable vlan <n>` enregistre VRAIMENT le VLAN — la branche était morte', async () => {
    const sw = await switchEnSysteme();
    await sw.executeCommand('dhcp snooping enable vlan 10');
    expect(sw.getSecurityService().getDhcpSnoopingVlans()).toContain(10);
    expect(await sw.executeCommand('display dhcp snooping'))
      .toContain('DHCP snooping running information for VLAN 10');
  });

  it('les deux vues déclarent une interface de confiance', async () => {
    // La vue INTERFACE (`dhcp snooping trusted`) marchait déjà ; la vue
    // SYSTÈME (`dhcp snooping trusted interface <if>`) était refusée, ce
    // qui rendait `SwitchSecurityService.dhcpSnoopingTrust` atteignable
    // par aucun chemin. Les deux écrivent maintenant dans le magasin qui
    // applique, pas seulement dans celui qui décrit.
    const sw = await switchEnSysteme();
    await sw.executeCommand('dhcp snooping enable');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('dhcp snooping trusted');
    await sw.executeCommand('quit');
    expect(await sw.executeCommand('dhcp snooping trusted interface GigabitEthernet0/0/2')).toBe('');
    const out = await sw.executeCommand('display dhcp snooping');
    expect(out).toContain('GigabitEthernet0/0/1');
    expect(out).toContain('GigabitEthernet0/0/2');
  });

  it('la confiance déclarée en vue système est celle que le plan de données applique', async () => {
    const sw = await switchEnSysteme();
    await sw.executeCommand('dhcp snooping enable');
    await sw.executeCommand('dhcp snooping trusted interface GigabitEthernet0/0/3');
    // Le magasin consulté par le plan de données, pas seulement celui
    // que l'affichage lit : accepter la commande sans l'appliquer
    // serait une promesse non tenue.
    expect([...sw._getDHCPSnoopingConfig().trustedPorts]).toContain('GigabitEthernet0/0/3');
    await sw.executeCommand('undo dhcp snooping trusted interface GigabitEthernet0/0/3');
    expect([...sw._getDHCPSnoopingConfig().trustedPorts]).not.toContain('GigabitEthernet0/0/3');
  });

  it('une interface inexistante est refusée, pas enregistrée', async () => {
    const sw = await switchEnSysteme();
    expect(await sw.executeCommand('dhcp snooping trusted interface GigabitEthernet9/9/9'))
      .toContain("Wrong parameter found at '^' position");
  });
});

describe('Scénario 5 — le routeur savait déjà faire, et le fait toujours', () => {
  it('LoopBack sur routeur : inchangé par ce lot', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface LoopBack0');
    expect(await r.executeCommand('ip address 2.2.2.2 32')).toBe('');
    await r.executeCommand('quit');
    expect(await r.executeCommand('display ip interface LoopBack0'))
      .toContain('Internet Address is 2.2.2.2/32');
    expect(await r.executeCommand('display ip interface brief'))
      .toContain('2.2.2.2/32');
  });
});

describe('Scénario 6 — ce qui reste refusé, et pourquoi c\'est correct', () => {
  it('IPv6 sur un switch est refusé : il n\'y a pas de pile v6 derrière', async () => {
    const sw = await switchEnSysteme();
    await sw.executeCommand('interface Vlanif1');
    expect(await sw.executeCommand('ipv6 enable')).toContain('Unrecognized command');
    expect(await sw.executeCommand('ipv6 address 2001:db8::1/64')).toContain('Unrecognized command');
    await sw.executeCommand('quit');
    expect(await sw.executeCommand('dhcpv6 server pool1')).toContain('Unrecognized command');
  });

  it('`display ospfv3` est refusé : le switch ne fait pas tourner OSPFv3', async () => {
    const sw = await switchEnSysteme();
    expect(await sw.executeCommand('display ospfv3')).toContain('Unrecognized command');
  });
});
