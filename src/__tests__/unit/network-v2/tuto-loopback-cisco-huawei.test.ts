/**
 * Le tutoriel « Les Interfaces Loopback : From Zero to Hero », parties
 * Cisco et Huawei, rejouées comme laboratoires.
 *
 * Ce que la mesure a trouvé avant qu'une ligne soit écrite, et que ces
 * cas tiennent maintenant :
 *
 * **Cisco.** `show interfaces Loopback0` n'écrivait que trois lignes —
 * l'état, `Hardware is Loopback`, l'adresse — alors qu'un vrai IOS en
 * écrit une vingtaine, dont les deux qui distinguent cette interface de
 * toutes les autres : `Encapsulation LOOPBACK` et un MTU de 1514. Le
 * bloc entier était exclu par un `if (!isLoopback)`.
 *
 * `show ip interface Loopback0` rendait le texte de `show interfaces`,
 * c'est-à-dire l'AUTRE commande. Les deux existent parce qu'elles
 * répondent à des questions différentes — le traitement IP contre le
 * lien — et les confondre privait la plateforme de la moitié de la
 * réponse.
 *
 * `show ip ospf interface Loopback0` annonçait `Network Type BROADCAST`
 * et `State DR` : une interface seule au monde se déclarait DR
 * d'elle-même. Le type `loopback` n'existait pas dans le moteur. Sa
 * conséquence n'est pas cosmétique et c'est le §8 du tutoriel : une
 * loopback est annoncée en HÔTE ISOLÉ /32 quel que soit son masque
 * (RFC 2328 §12.4.1.1), et `ip ospf network point-to-point` est ce qui
 * fait annoncer le vrai préfixe. Les deux moitiés sont vérifiées ici
 * sur la table de routage du VOISIN, pas sur un affichage local.
 *
 * **Huawei.** `display ip interface brief` imprimait sa légende
 * `(s): spoofing` sans qu'aucune ligne ne porte jamais la marque
 * qu'elle explique, et `display interface LoopBack0` répondait `UP` sec
 * là où VRP écrit `UP (spoofing)`. Ce n'est pas un ornement : c'est la
 * façon dont VRP dit que l'état est décrété et non observé, donc la
 * raison même de se servir d'une loopback comme Router ID.
 *
 * `source LoopBack 0` sous une interface Tunnel ne gardait que le
 * premier mot — la configuration rendue portait `source LoopBack`, une
 * interface qui n'existe pas, et une topologie relue rejouait cela.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';

async function ios(r: CiscoRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await r.executeCommand(c));
  return last;
}

async function config(r: CiscoRouter, cmds: string[]): Promise<void> {
  await ios(r, ['enable', 'configure terminal', ...cmds, 'end']);
}

async function vrp(r: HuaweiRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await r.executeCommand(c));
  return last;
}

// ── Cisco — partie 3 du tutoriel ─────────────────────────────────────

describe('Cisco : créer une loopback et la voir', () => {
  it('l\'interface naît UP sans `no shutdown`, comme le dit le tutoriel', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, ['interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255']);
    const out = await ios(r, ['show ip interface brief']);
    expect(out).toMatch(/Loopback0\s+1\.1\.1\.1\s+YES manual up\s+up/);
  });

  it('`show interface Loopback 0` rend le bloc d\'un vrai IOS, encapsulation et MTU compris', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, [
      'interface Loopback 0',
      'ip address 1.1.1.1 255.255.255.255',
      'description Router ID and Management Loopback',
    ]);
    const out = await ios(r, ['show interface Loopback 0']);

    expect(out).toContain('Loopback0 is up, line protocol is up');
    expect(out).toContain('Hardware is Loopback');
    expect(out).toContain('Description: Router ID and Management Loopback');
    expect(out).toContain('Internet address is 1.1.1.1/32');
    // Les trois faits que le tutoriel met en avant, et qui manquaient.
    expect(out).toContain('MTU 1514 bytes, BW 8000000 Kbit/sec, DLY 5000 usec,');
    expect(out).toContain('     reliability 255/255, txload 1/255, rxload 1/255');
    expect(out).toContain('Encapsulation LOOPBACK, loopback not set');
    expect(out).toContain('Last clearing of "show interface" counters never');
    // Et ce qu'une loopback n'a PAS : pas d'ARP, pas de média.
    expect(out).not.toContain('Encapsulation ARPA');
    expect(out).not.toContain('media type is RJ45');
  });

  /**
   * Les valeurs sont sur le PORT, pas dans le rendu : `bandwidth`
   * continue donc de les surcharger par la voie normale. Une constante
   * d'affichage aurait ignoré la commande.
   */
  it('la bande passante par défaut est celle d\'IOS, et reste surchargeable', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, ['interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255']);
    expect(await ios(r, ['show interface Loopback 0'])).toContain('BW 8000000 Kbit/sec');

    await config(r, ['interface Loopback 0', 'bandwidth 64']);
    expect(await ios(r, ['show interface Loopback 0'])).toContain('BW 64 Kbit/sec');
  });

  it('`show ip interface` répond au traitement IP, pas au lien — ce sont deux commandes', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, ['interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255']);
    const ipView = await ios(r, ['show ip interface Loopback 0']);
    const linkView = await ios(r, ['show interface Loopback 0']);

    expect(ipView).toContain('Broadcast address is 255.255.255.255');
    expect(ipView).toContain('MTU is 1514 bytes');
    expect(ipView).toContain('Helper address is not set');
    expect(ipView).toContain('IP fast switching is enabled');
    // Ce qui appartient à l'autre vue n'est pas ici.
    expect(ipView).not.toContain('Hardware is Loopback');
    expect(ipView).not.toContain('Encapsulation LOOPBACK');
    expect(ipView).not.toBe(linkView);
  });

  it('le MTU affiché par la vue IP est celui du port, pas une constante', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, ['interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255', 'mtu 9000']);
    expect(await ios(r, ['show ip interface Loopback 0'])).toContain('MTU is 9000 bytes');
  });

  it('on crée autant de loopbacks qu\'on veut, et `no interface` en retire une', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, [
      'interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
      'interface Loopback 1', 'ip address 192.168.100.1 255.255.255.255', 'exit',
      'interface Loopback 100', 'ip address 172.16.1.1 255.255.255.0',
    ]);
    expect(await ios(r, ['show ip interface brief'])).toContain('Loopback100');

    await config(r, ['no interface Loopback 100']);
    const apres = await ios(r, ['show ip interface brief']);
    expect(apres).not.toContain('Loopback100');
    expect(apres).toContain('Loopback0');
    expect(apres).toContain('Loopback1');
  });
});

// ── Cisco — parties 3 et 8 : OSPF ────────────────────────────────────

/** R1 —— R2, chacun avec une loopback /32 et une loopback /24. */
async function labOspf(): Promise<{ r1: CiscoRouter; r2: CiscoRouter }> {
  const r1 = new CiscoRouter('router-cisco', 'R1');
  const r2 = new CiscoRouter('router-cisco', 'R2');
  new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

  await config(r1, [
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface Loopback 10', 'ip address 172.16.1.1 255.255.255.0', 'exit',
    'router ospf 1', 'router-id 1.1.1.1',
    'network 10.0.12.0 0.0.0.255 area 0',
    'network 1.1.1.1 0.0.0.0 area 0',
    'network 172.16.0.0 0.0.255.255 area 0',
  ]);
  await config(r2, [
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2',
    'network 10.0.12.0 0.0.0.255 area 0',
  ]);
  return { r1, r2 };
}

describe('Cisco : OSPF et les loopbacks', () => {
  it('le Router ID se fixe sur l\'adresse de la loopback', async () => {
    const { r1 } = await labOspf();
    expect(await ios(r1, ['show ip ospf interface Loopback0']))
      .toContain('Router ID 1.1.1.1');
  });

  /**
   * Mesuré plutôt que supposé : un vrai IOS n'écrit PAS
   * `No Hellos (Passive interface)` sous une loopback — une interface
   * de bouclage n'émet aucun Hello, passive ou non, donc la mention
   * n'aurait rien à distinguer. Ce qui s'observe est que la commande
   * est retenue.
   */
  it('`passive-interface Loopback0` est accepté et retenu', async () => {
    const { r1 } = await labOspf();
    await config(r1, ['router ospf 1', 'passive-interface Loopback0']);
    // La commande était honorée par le moteur et rapportée par
    // PERSONNE — ni la configuration, ni `show ip protocols`. Une
    // configuration relue REFAIT le processus à l'import d'une
    // topologie : l'interface passive s'y perdait et se remettait à
    // émettre.
    expect(await ios(r1, ['show running-config']))
      .toContain('passive-interface Loopback0');
    const protos = await ios(r1, ['show ip protocols']);
    expect(protos).toContain('Passive Interface(s):');
    expect(protos).toContain('    Loopback0');
    // Et la vue OSPF de la loopback reste celle d'un hôte isolé.
    expect(await ios(r1, ['show ip ospf interface Loopback0']))
      .toContain('Loopback interface is treated as a stub Host');
  });

  /**
   * Le §8 du tutoriel, dans les deux sens. C'est le cas qui fait toute
   * la différence entre une correction réelle et un affichage retouché :
   * ce qu'on vérifie est ce que le VOISIN a dans sa table.
   */
  it('une loopback est annoncée en hôte isolé /32, quel que soit son masque', async () => {
    const { r1, r2 } = await labOspf();

    const vue = await ios(r1, ['show ip ospf interface Loopback10']);
    expect(vue).toContain('Network Type LOOPBACK');
    expect(vue).toContain('Loopback interface is treated as a stub Host');
    // Une interface seule n'élit rien : elle ne se déclare pas DR.
    expect(vue).not.toContain('State DR');
    expect(vue).not.toContain('DR: ');

    // Loopback10 porte un /24 ; le voisin la voit en /32.
    const table = await ios(r2, ['show ip route']);
    expect(table).toMatch(/O\s+172\.16\.1\.1\/32/);
    expect(table).not.toMatch(/O\s+172\.16\.1\.0\/24/);
  });

  it('`ip ospf network point-to-point` fait annoncer le préfixe configuré', async () => {
    const { r1, r2 } = await labOspf();
    await config(r1, ['interface Loopback10', 'ip ospf network point-to-point']);

    const vue = await ios(r1, ['show ip ospf interface Loopback10']);
    expect(vue).toContain('Network Type POINT-TO-POINT');
    expect(vue).not.toContain('treated as a stub Host');
    // La machine à états est relancée : l'état d'avant ne survit pas.
    expect(vue).toContain('State PointToPoint');

    const table = await ios(r2, ['show ip route']);
    expect(table).toMatch(/O\s+172\.16\.1\.0\/24/);
    expect(table).not.toMatch(/O\s+172\.16\.1\.1\/32/);
  });
});

// ── Cisco — parties 3 : BGP, tunnel, management ──────────────────────

describe('Cisco : la loopback comme source stable', () => {
  it('`neighbor … update-source Loopback0` se configure et se relit', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, [
      'interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
      'router bgp 65001',
      'neighbor 2.2.2.2 remote-as 65001',
      'neighbor 2.2.2.2 update-source Loopback0',
    ]);
    expect(await ios(r, ['show running-config']))
      .toContain('neighbor 2.2.2.2 update-source Loopback0');
  });

  it('`tunnel source Loopback0` se configure et se relit', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, [
      'interface Loopback 0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
      'interface Tunnel 0',
      'tunnel source Loopback0',
      'tunnel destination 2.2.2.2',
    ]);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain('tunnel source Loopback0');
    expect(cfg).toContain('tunnel destination 2.2.2.2');
  });

  it('`ip ssh source-interface Loopback1` se configure et se relit', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await config(r, [
      'interface Loopback 1', 'ip address 192.168.100.1 255.255.255.255', 'exit',
      'ip ssh source-interface Loopback1',
    ]);
    expect(await ios(r, ['show running-config']))
      .toContain('ip ssh source-interface Loopback1');
  });
});

// ── Huawei — partie 4 du tutoriel ────────────────────────────────────

describe('Huawei : créer une LoopBack et la voir', () => {
  it('le masque s\'écrit en longueur de préfixe, et l\'interface naît UP', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, [
      'system-view', 'interface LoopBack 0', 'ip address 1.1.1.1 32',
      'description Router_ID_OSPF', 'quit', 'quit',
    ]);
    expect(await vrp(r, ['display interface LoopBack 0']))
      .toContain('LoopBack0 current state : UP');
  });

  /**
   * `(spoofing)` est ce que VRP écrit pour dire que l'état du protocole
   * de liaison est DÉCRÉTÉ et non observé. Le tutoriel le souligne
   * explicitement, et la vue répondait `UP` sec.
   */
  it('`display interface` marque le protocole comme simulé', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, ['system-view', 'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit', 'quit']);
    expect(await vrp(r, ['display interface LoopBack 0']))
      .toContain('Line protocol current state : UP (spoofing)');
  });

  it('`display ip interface brief` porte enfin la marque que sa propre légende explique', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, [
      'system-view',
      'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit',
      'interface GigabitEthernet0/0/0', 'ip address 10.0.12.1 24', 'quit', 'quit',
    ]);
    const out = await vrp(r, ['display ip interface brief']);
    expect(out).toContain('(s): spoofing');
    expect(out).toMatch(/LoopBack0\s+1\.1\.1\.1\/32\s+up\s+up\(s\)/);
    // Une interface physique n'est pas marquée : la marque distingue.
    expect(out).not.toMatch(/GigabitEthernet0\/0\/0.*up\(s\)/);
  });

  it('`display ip interface LoopBack 0` et `display interface` s\'accordent sur le même port', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, ['system-view', 'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit', 'quit']);
    for (const c of ['display interface LoopBack 0', 'display ip interface LoopBack 0']) {
      expect(String(await vrp(r, [c])), c).toContain('Line protocol current state : UP (spoofing)');
    }
  });

  it('`source LoopBack 0` garde son numéro dans la configuration', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, [
      'system-view',
      'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit',
      'interface Tunnel 0/0/0', 'source LoopBack 0', 'destination 2.2.2.2', 'quit', 'quit',
    ]);
    const cfg = await vrp(r, ['display current-configuration']);
    expect(cfg).toContain('source LoopBack0');
    expect(cfg).not.toMatch(/source LoopBack\s*$/m);
  });

  it('la forme collée et la forme séparée désignent la même interface', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, [
      'system-view',
      'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit',
      'interface Tunnel 0/0/0', 'source loopback0', 'quit', 'quit',
    ]);
    expect(await vrp(r, ['display current-configuration'])).toContain('source LoopBack0');
  });

  it('`peer … connect-interface LoopBack0` se configure et se relit', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, [
      'system-view',
      'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit',
      'bgp 65001', 'peer 2.2.2.2 as-number 65001',
      'peer 2.2.2.2 connect-interface LoopBack0', 'quit', 'quit',
    ]);
    expect(await vrp(r, ['display current-configuration']))
      .toContain('peer 2.2.2.2 connect-interface LoopBack0');
  });

  it('`undo interface LoopBack 0` retire l\'interface', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, ['system-view', 'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit', 'quit']);
    expect(await vrp(r, ['display ip interface brief'])).toContain('LoopBack0');

    await vrp(r, ['system-view', 'undo interface LoopBack 0', 'quit']);
    expect(await vrp(r, ['display ip interface brief'])).not.toContain('LoopBack0');
  });

  it('la loopback entre dans la table de routage en Direct /32', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await vrp(r, ['system-view', 'interface LoopBack 0', 'ip address 1.1.1.1 32', 'quit', 'quit']);
    expect(await vrp(r, ['display ip routing-table']))
      .toMatch(/1\.1\.1\.1\/32\s+Direct/);
  });
});
