/**
 * Le tutoriel « Debugging et Logging sur Cisco » rejoué en laboratoire.
 *
 * Chaque `describe` correspond à une partie du tutoriel, et chaque cas à
 * une manipulation qu'un lecteur tape. Un tutoriel qu'on ne peut pas
 * suivre jusqu'au bout est pire qu'absent : ce fichier est là pour que
 * la promesse tienne.
 *
 * Ce que la première mesure a trouvé, et que ce fichier tient désormais :
 *
 *  - `show logging last N` n'existait pas (`% Invalid input`) alors que
 *    c'est la première chose qu'on tape sur un tampon de 64 Ko.
 *  - `no debug condition <n>` était refusé : on posait une condition
 *    numérotée qu'aucune commande ne pouvait retirer par son numéro.
 *  - `debug ip dhcp server packets` était refusé, le mot-clé étant
 *    enregistré au singulier — ce qui inverse la règle d'abréviation
 *    d'IOS, la forme complète étant refusée et l'abrégée acceptée.
 *  - **EEM ne se déclenchait jamais** sur un motif syslog, et quand on
 *    l'a fait tirer, son action `syslog priority … msg` n'était pas
 *    analysée, et l'action n'écrivait rien dans le journal. Trois
 *    défauts empilés sur la partie 8 entière.
 *
 * Deux fausses alertes sont écartées ici plutôt que tues, parce qu'elles
 * ressemblent à des défauts et n'en sont pas : `logging trap`/`facility`/
 * `monitor` n'apparaissent dans la configuration que s'ils s'écartent du
 * défaut (règle d'IOS, vérifiée plus bas), et un câble débranché produit
 * bien ses `%LINK-3-UPDOWN`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function routeur(nom = 'R1'): Promise<CiscoRouter> {
  const r = new CiscoRouter('router-cisco', nom);
  await r.executeCommand('enable');
  return r;
}

/** Enchaîne des lignes de configuration et rend la dernière sortie. */
async function config(dev: CiscoRouter | CiscoSwitch, ...lignes: string[]): Promise<string> {
  await dev.executeCommand('configure terminal');
  let out = '';
  for (const l of lignes) out = String(await dev.executeCommand(l));
  await dev.executeCommand('end');
  return out;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;

// ── Partie 2 — configuration de base ────────────────────────────────

describe('Partie 2 — les trois lignes indispensables', () => {
  it('les trois lignes du tutoriel sont acceptées et prises en compte', async () => {
    const r = await routeur();
    await config(r,
      'logging buffered 64000 debugging',
      'service timestamps log datetime msec',
      'logging console notifications');
    const out = String(await r.executeCommand('show logging'));
    expect(out).toContain('Console logging: level notifications');
    expect(out).toContain('Buffer logging:  level debugging');
    expect(out).toContain('Log Buffer (64000 bytes)');
  });

  it('l\'horodatage à la milliseconde est réellement appliqué', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 64000 debugging', 'service timestamps log datetime msec');
    await config(r, 'interface GigabitEthernet0/0', 'shutdown');
    const out = String(await r.executeCommand('show logging'));
    // `*Aug  9 23:14:32.451:` — mois, jour, heure, ET millisecondes.
    expect(out).toMatch(/\*\w{3}\s+\d+ \d{2}:\d{2}:\d{2}\.\d{3}: %/);
  });

  it('le serveur syslog externe : host, trap et facility', async () => {
    const r = await routeur();
    await config(r, 'logging host 192.168.1.100', 'logging trap informational', 'logging facility local7');
    const out = String(await r.executeCommand('show logging'));
    expect(out).toContain('Trap logging: level informational');
    expect(out).toContain('Logging to 192.168.1.100');
    expect(out).toContain('Facility: local7');
  });

  /**
   * La fausse alerte annoncée en tête de fichier : une valeur ÉGALE au
   * défaut n'est pas rendue, ce qui est la règle d'IOS et non un oubli.
   */
  it('la configuration ne rend que ce qui s\'écarte du défaut', async () => {
    const r = await routeur();
    await config(r, 'logging trap informational', 'logging facility local7');
    expect(String(await r.executeCommand('show running-config'))).not.toContain('logging trap');
    await config(r, 'logging trap warnings', 'logging facility local5', 'logging monitor errors');
    const rc = String(await r.executeCommand('show running-config'));
    expect(rc).toContain('logging trap warnings');
    expect(rc).toContain('logging facility local5');
    expect(rc).toContain('logging monitor errors');
  });

  it('les huit niveaux sont acceptés, par nom et par numéro', async () => {
    const r = await routeur();
    for (const n of ['emergencies', 'alerts', 'critical', 'errors',
      'warnings', 'notifications', 'informational', 'debugging', '0', '7']) {
      const out = await config(r, `logging buffered ${n}`);
      expect(out, `logging buffered ${n}`).not.toMatch(REFUS);
    }
  });

  it('un niveau filtre vraiment : `warnings` garde le 3 et jette le 5', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 64000 warnings');
    await config(r, 'interface GigabitEthernet0/0', 'shutdown', 'no shutdown');
    const out = String(await r.executeCommand('show logging'));
    expect(out, 'LINK-3 (niveau 3) doit être gardé').toContain('%LINK-3-UPDOWN');
    expect(out, 'LINEPROTO-5 (niveau 5) doit être jeté').not.toContain('%LINEPROTO-5');
  });
});

describe('Partie 2 — lire et filtrer le tampon', () => {
  /** Un tampon avec assez de lignes pour que `last N` ait un sens. */
  async function routeurBavard(): Promise<CiscoRouter> {
    const r = await routeur();
    await config(r, 'logging buffered 64000 debugging');
    for (let i = 0; i < 4; i++) {
      await config(r, 'interface GigabitEthernet0/0', 'shutdown', 'no shutdown');
    }
    return r;
  }

  it('`show logging last N` ne rend que les N dernières lignes', async () => {
    const r = await routeurBavard();
    const tout = String(await r.executeCommand('show logging'));
    const cinq = String(await r.executeCommand('show logging last 5'));
    const compte = (s: string) => s.split('\n').filter((l) => /^\*\w{3}/.test(l)).length;
    expect(compte(tout)).toBeGreaterThan(5);
    expect(compte(cinq)).toBe(5);
    // L'en-tête reste : IOS ne le supprime pas.
    expect(cinq).toContain('Syslog logging: enabled');
    // Ce sont bien les DERNIÈRES.
    const derniere = tout.split('\n').filter((l) => /^\*\w{3}/.test(l)).at(-1)!;
    expect(cinq).toContain(derniere);
  });

  it('`show logging last` refuse ce qui n\'est pas un nombre', async () => {
    const r = await routeurBavard();
    expect(String(await r.executeCommand('show logging last'))).toMatch(REFUS);
    expect(String(await r.executeCommand('show logging last zero'))).toMatch(REFUS);
    expect(String(await r.executeCommand('show logging last 0'))).toMatch(REFUS);
  });

  it('include, exclude, count et begin', async () => {
    const r = await routeurBavard();
    const inc = String(await r.executeCommand('show logging | include UPDOWN'));
    expect(inc).toContain('UPDOWN');
    expect(inc).not.toContain('Syslog logging: enabled');

    const exc = String(await r.executeCommand('show logging | exclude UPDOWN'));
    expect(exc).not.toContain('UPDOWN');

    const cnt = String(await r.executeCommand('show logging | count UPDOWN')).trim();
    expect(Number(cnt)).toBeGreaterThan(0);

    const beg = String(await r.executeCommand('show logging | begin Log Buffer'));
    expect(beg.startsWith('Log Buffer')).toBe(true);
  });

  it('`clear logging` vide vraiment le tampon', async () => {
    const r = await routeurBavard();
    expect(String(await r.executeCommand('show logging'))).toContain('UPDOWN');
    await r.executeCommand('clear logging');
    expect(String(await r.executeCommand('show logging'))).not.toContain('UPDOWN');
  });
});

// ── Parties 3 et 4 ──────────────────────────────────────────────────

describe('Parties 3 et 4 — logging synchronous et terminal monitor', () => {
  it('`logging synchronous` se pose sur la console et sur les vty', async () => {
    const r = await routeur();
    await config(r, 'line console 0', 'logging synchronous', 'exit',
      'line vty 0 4', 'logging synchronous');
    const rc = String(await r.executeCommand('show running-config'));
    expect(rc.match(/logging synchronous/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('`terminal monitor` et `terminal no monitor` sont acceptés sans bruit', async () => {
    const r = await routeur();
    expect(String(await r.executeCommand('terminal monitor'))).not.toMatch(REFUS);
    expect(String(await r.executeCommand('terminal no monitor'))).not.toMatch(REFUS);
  });
});

// ── Partie 5 — les commandes debug ──────────────────────────────────

describe('Partie 5 — le scalpel', () => {
  it('tous les debug listés par le tutoriel existent', async () => {
    const r = await routeur();
    for (const c of [
      'debug ip ospf events', 'debug ip ospf adj', 'debug ip ospf hello', 'debug ip ospf packet',
      'debug interface GigabitEthernet0/0', 'debug ip routing', 'debug arp', 'debug ip icmp',
      'debug ip dhcp server events', 'debug ip dhcp server packets',
      'debug ip ssh', 'debug aaa authentication', 'debug ip packet',
    ]) {
      expect(String(await r.executeCommand(c)), c).not.toMatch(REFUS);
    }
  });

  /**
   * `packets` est le mot-clé d'IOS ; `packet` en est donc une
   * abréviation valide. Les deux doivent passer — c'est la règle
   * d'abréviation d'IOS, et elle était inversée.
   */
  it('`debug ip dhcp server` accepte ses trois mots-clés, pluriel compris', async () => {
    const r = await routeur();
    for (const c of ['debug ip dhcp server events', 'debug ip dhcp server packets',
      'debug ip dhcp server packet', 'debug ip dhcp server linkage']) {
      expect(String(await r.executeCommand(c)), c).not.toMatch(REFUS);
    }
  });

  it('`show debug` liste ce qui tourne, `no debug all` coupe tout', async () => {
    const r = await routeur();
    await r.executeCommand('debug ip ospf events');
    await r.executeCommand('debug arp');
    const actifs = String(await r.executeCommand('show debug'));
    expect(actifs).toContain('OSPF events debugging is on');
    expect(actifs).toContain('ARP packet debugging is on');
    expect(String(await r.executeCommand('no debug all'))).toContain('All possible debugging has been turned off');
    expect(String(await r.executeCommand('show debug'))).toContain('No debug flags are enabled');
  });

  it('`undebug all` est un synonyme exact', async () => {
    const r = await routeur();
    await r.executeCommand('debug arp');
    expect(String(await r.executeCommand('undebug all'))).toContain('All possible debugging has been turned off');
    expect(String(await r.executeCommand('show debug'))).toContain('No debug flags are enabled');
  });

  it('les debug STP existent sur un commutateur', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await s.executeCommand('enable');
    for (const c of ['debug spanning-tree events', 'debug spanning-tree bpdu']) {
      expect(String(await s.executeCommand(c)), c).not.toMatch(REFUS);
    }
    expect(String(await s.executeCommand('show debug'))).toContain('Spanning Tree');
  });

  /** Un debug qui n'écrit rien serait une décoration : celui-ci écrit. */
  it('un debug actif écrit de vraies lignes issues du vrai trafic', async () => {
    const r = await routeur();
    const pc = new LinuxPC('linux-pc', 'PC1');
    await config(r, 'logging buffered 64000 debugging',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown');
    new Cable('l1').connect(r.getPort('GigabitEthernet0/0')!, [...pc.getPorts().values()][0]);
    await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
    await r.executeCommand('debug ip icmp');
    await r.executeCommand('clear logging');
    await r.executeCommand('ping 10.0.0.2');
    expect(String(await r.executeCommand('show logging | include ICMP'))).toContain('ICMP: echo');
  });
});

// ── Partie 6 — conditional debugging ────────────────────────────────

describe('Partie 6 — le debug chirurgical', () => {
  async function routeurAvecAcl(): Promise<CiscoRouter> {
    const r = await routeur();
    await config(r, 'ip access-list extended DEBUG_FILTER',
      'permit ip host 192.168.10.10 any', 'permit ip any host 192.168.10.10');
    return r;
  }

  it('poser une condition par ACL, la voir, la retirer PAR SON NUMÉRO', async () => {
    const r = await routeurAvecAcl();
    expect(String(await r.executeCommand('debug condition ip access-list DEBUG_FILTER')))
      .toContain('Condition 1 set');
    expect(String(await r.executeCommand('show debug condition')))
      .toContain('Condition 1: ip access-list DEBUG_FILTER');
    expect(String(await r.executeCommand('no debug condition 1')))
      .toContain('Condition 1 has been removed');
    expect(String(await r.executeCommand('show debug condition')))
      .toContain('Condition 1 is not set');
  });

  it('poser une condition par interface', async () => {
    const r = await routeur();
    expect(String(await r.executeCommand('debug condition interface GigabitEthernet0/0')))
      .toContain('Condition 1 set');
    expect(String(await r.executeCommand('show debug condition')))
      .toContain('interface GigabitEthernet0/0');
  });

  /**
   * Le numéro est un IDENTIFIANT, pas un rang : retirer la première de
   * trois ne doit pas renuméroter les autres, sans quoi `no debug
   * condition 2` supprimerait une condition que l'opérateur n'a pas
   * désignée.
   */
  it('les numéros ne bougent pas quand on en retire une au milieu', async () => {
    const r = await routeurAvecAcl();
    await r.executeCommand('debug condition ip access-list DEBUG_FILTER');
    await r.executeCommand('debug condition interface GigabitEthernet0/0');
    await r.executeCommand('debug condition interface GigabitEthernet0/1');
    await r.executeCommand('no debug condition 2');
    const restant = String(await r.executeCommand('show debug condition'));
    expect(restant).toContain('Condition 1: ip access-list DEBUG_FILTER');
    expect(restant).toContain('Condition 3: interface GigabitEthernet0/1');
    expect(restant).not.toContain('Condition 2:');
    // Le numéro libéré est réutilisé, comme un emplacement.
    expect(String(await r.executeCommand('debug condition vrf ROUGE'))).toContain('Condition 2 set');
  });

  it('retirer un numéro qui n\'existe pas le dit', async () => {
    const r = await routeur();
    expect(String(await r.executeCommand('no debug condition 7'))).toContain('was not set');
  });

  it('`no debug condition all` retire tout', async () => {
    const r = await routeurAvecAcl();
    await r.executeCommand('debug condition ip access-list DEBUG_FILTER');
    await r.executeCommand('debug condition interface GigabitEthernet0/0');
    expect(String(await r.executeCommand('no debug condition all')))
      .toContain('All conditions have been removed');
    expect(String(await r.executeCommand('show debug condition'))).toContain('Condition 1 is not set');
  });

  /** La condition doit FILTRER, pas seulement s'afficher. */
  it('un debug sous condition ne parle que du trafic visé', async () => {
    const r = await routeur();
    const pc = new LinuxPC('linux-pc', 'PC2');
    await config(r, 'logging buffered 64000 debugging',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown');
    await config(r, 'ip access-list extended AUTRE_HOTE', 'permit ip host 10.0.0.99 any');
    new Cable('l2').connect(r.getPort('GigabitEthernet0/0')!, [...pc.getPorts().values()][0]);
    await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
    await r.executeCommand('debug ip icmp');

    // Témoin : sans condition, le ping vers .2 écrit.
    await r.executeCommand('clear logging');
    await r.executeCommand('ping 10.0.0.2');
    expect(String(await r.executeCommand('show logging | include ICMP'))).toContain('ICMP');

    // Avec une condition qui ne vise QUE .99, le même ping n'écrit plus.
    await r.executeCommand('debug condition ip access-list AUTRE_HOTE');
    await r.executeCommand('clear logging');
    await r.executeCommand('ping 10.0.0.2');
    expect(String(await r.executeCommand('show logging | include ICMP')).trim()).toBe('');
  });
});

// ── Partie 7 — scénarios ────────────────────────────────────────────

describe('Partie 7 — les scénarios de diagnostic', () => {
  it('scénario 1 : un lien qui bat laisse sa trace dans les logs', async () => {
    const r = await routeur();
    const pc = new LinuxPC('linux-pc', 'PC3');
    await config(r, 'logging buffered 64000 debugging',
      'interface GigabitEthernet0/0', 'no shutdown');
    const port = r.getPort('GigabitEthernet0/0')!;
    const distant = [...pc.getPorts().values()][0];
    for (let i = 0; i < 3; i++) {
      const c = new Cable(`flap${i}`);
      c.connect(port, distant);
      c.disconnect();
    }
    const out = String(await r.executeCommand('show logging | include UPDOWN'));
    expect(out).toContain('changed state to up');
    expect(out).toContain('changed state to down');
    const n = Number(String(await r.executeCommand('show logging | count UPDOWN')).trim());
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it('scénario 1 : les compteurs d\'erreurs de l\'interface sont là', async () => {
    const r = await routeur();
    const out = String(await r.executeCommand('show interfaces GigabitEthernet0/0'));
    expect(out).toMatch(/input errors, \d+ CRC/);
  });

  it('scénario 2 : les vues OSPF du diagnostic répondent', async () => {
    const r1 = await routeur('R1');
    const r2 = await routeur('R2');
    await config(r1, 'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown');
    await config(r2, 'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown');
    new Cable('l12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    await config(r1, 'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
    await config(r2, 'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');

    expect(String(await r1.executeCommand('show ip ospf neighbor'))).toContain('2.2.2.2');
    const iface = String(await r1.executeCommand('show ip ospf interface GigabitEthernet0/0'));
    expect(iface).toContain('Hello 10, Dead 40');
    expect(iface).toContain('Router ID 1.1.1.1');
    expect(String(await r1.executeCommand('show ip ospf interface brief'))).toContain('Gi0/0');
    expect(String(await r1.executeCommand('show run | section ospf'))).toContain('network 10.0.12.0');
  });

  it('scénario 2 : `debug ip ospf adj` raconte la montée de l\'adjacence', async () => {
    const r1 = await routeur('R1');
    const r2 = await routeur('R2');
    await config(r1, 'logging buffered 64000 debugging',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown');
    await config(r2, 'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown');
    new Cable('l12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    await r1.executeCommand('debug ip ospf adj');
    await r1.executeCommand('clear logging');
    await config(r1, 'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
    await config(r2, 'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
    const out = String(await r1.executeCommand('show logging'));
    expect(out).toContain('state Down -> Init');
    expect(out).toContain('state Loading -> Full');
    expect(out).toContain('%OSPF-5-ADJCHG');
  });

  it('scénario 3 : `show ip route <réseau>` répond, et dit quand il ne sait pas', async () => {
    const r = await routeur();
    const pc = new LinuxPC('linux-pc', 'PC4');
    await config(r, 'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown');
    new Cable('l3').connect(r.getPort('GigabitEthernet0/0')!, [...pc.getPorts().values()][0]);
    expect(String(await r.executeCommand('show ip route 10.0.12.0'))).toContain('10.0.12.0');
    expect(String(await r.executeCommand('show ip route 192.168.30.0'))).toContain('% Network not in table');
  });

  it('scénario 3 : la LSDB se consulte par Router ID', async () => {
    const r = await routeur();
    await config(r, 'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown');
    await config(r, 'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
    expect(String(await r.executeCommand('show ip ospf database router 1.1.1.1'))).toContain('1.1.1.1');
  });

  it('scénario 4 : le debug ARP ciblé montre les requêtes sans réponse', async () => {
    const r = await routeur();
    const pc = new LinuxPC('linux-pc', 'PC5');
    await config(r, 'logging buffered 64000 debugging',
      'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown');
    new Cable('l4').connect(r.getPort('GigabitEthernet0/0')!, [...pc.getPorts().values()][0]);
    await pc.executeCommand('ip addr add 192.168.10.2/24 dev eth0');
    await r.executeCommand('debug arp');
    await r.executeCommand('clear logging');
    // .55 n'existe pas : le routeur cherche et ne trouve personne.
    await r.executeCommand('ping 192.168.10.55');
    expect(String(await r.executeCommand('show logging | include ARP'))).toContain('192.168.10.55');
  });
});

// ── Partie 8 — EEM ──────────────────────────────────────────────────

describe('Partie 8 — EEM agit sur les logs', () => {
  it('exemple 1 : un applet déclenché par un motif syslog ÉCRIT son alerte', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 64000 debugging',
      'interface GigabitEthernet0/0', 'no shutdown');
    await config(r, 'event manager applet IF_DOWN',
      'event syslog pattern "UPDOWN.*GigabitEthernet0/0.*down"',
      'action 1.0 syslog priority critical msg "ALERTE: Gi0/0 est tombee"');
    await r.executeCommand('clear logging');
    await config(r, 'interface GigabitEthernet0/0', 'shutdown');
    const out = String(await r.executeCommand('show logging | include ALERTE'));
    expect(out).toContain('ALERTE: Gi0/0 est tombee');
    // La forme d'IOS : `%HA_EM-<sev>-LOG: <applet>: <message>`, et
    // `priority critical` vaut bien la sévérité 2.
    expect(out).toContain('%HA_EM-2-LOG: IF_DOWN:');
  });

  it('l\'applet compte ses déclenchements', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 64000 debugging');
    await config(r, 'event manager applet CONFIG_CHANGE',
      'event syslog pattern "SYS-5-CONFIG_I"',
      'action 1.0 syslog msg "CONFIG modifiee"');
    await config(r, 'hostname R1b');
    expect(String(await r.executeCommand('show event manager policy registered')))
      .toMatch(/CONFIG_CHANGE\s+triggers=1\s+actions=1\s+hits=[1-9]/);
  });

  /**
   * Le motif porte sur la ligne ENTIÈRE, préfixe compris — c'est ainsi
   * qu'on écrit un déclencheur EEM, et c'était le défaut : comparé au
   * seul corps du message, `SYS-5-CONFIG_I` ne pouvait jamais matcher.
   */
  it('un motif écrit sur le mnémonique se déclenche', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 64000 debugging');
    await config(r, 'event manager applet SUR_MNEMONIQUE',
      'event syslog pattern "SYS-5-CONFIG_I"',
      'action 1.0 syslog msg "VU_PAR_MNEMONIQUE"');
    await r.executeCommand('clear logging');
    await config(r, 'hostname R1c');
    expect(String(await r.executeCommand('show logging | include VU_PAR_MNEMONIQUE')))
      .toContain('VU_PAR_MNEMONIQUE');
  });

  it('exemple 2 : `$_event_pub_time` est substitué, une variable inconnue reste littérale', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 64000 debugging');
    await config(r, 'event manager applet HORODATE',
      'event syslog pattern "SYS-5-CONFIG_I"',
      'action 1.0 syslog msg "quand: $_event_pub_time qui: $_cli_username"');
    await r.executeCommand('clear logging');
    await config(r, 'hostname R1d');
    const out = String(await r.executeCommand('show logging | include quand:'));
    expect(out).toMatch(/quand: \d{9,}/);
    // `$_cli_username` n'est défini que derrière un `event cli` : un vrai
    // EEM le laisse tel quel ici, et inventer une valeur serait pire.
    expect(out).toContain('$_cli_username');
  });

  it('exemple 3 : les actions `wait` et `cli command` sont enregistrées', async () => {
    const r = await routeur();
    await config(r, 'event manager applet ERRDISABLE_RECOVERY',
      'event syslog pattern "ERRDISABLE.*GigabitEthernet0"',
      'action 1.0 wait 60',
      'action 2.0 cli command "enable"',
      'action 3.0 cli command "configure terminal"');
    expect(String(await r.executeCommand('show event manager policy registered')))
      .toMatch(/ERRDISABLE_RECOVERY\s+triggers=1\s+actions=3/);
  });

  /** Une action qu'on ne sait pas lire doit être refusée, pas avalée. */
  it('une forme d\'action inconnue est refusée', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('event manager applet BANCAL');
    expect(String(await r.executeCommand('action 1.0 syslog priority zzz msg "x"'))).toMatch(REFUS);
    expect(String(await r.executeCommand('action 2.0 nimportequoi'))).toMatch(REFUS);
    expect(String(await r.executeCommand('action 3.0 syslog'))).toMatch(REFUS);
    await r.executeCommand('end');
    expect(String(await r.executeCommand('show event manager policy registered')))
      .toMatch(/BANCAL\s+triggers=0\s+actions=0/);
  });
});

// ── Partie 9 — les pièges ───────────────────────────────────────────

describe('Partie 9 — les pièges', () => {
  it('piège 2 : `show debug` puis `no debug all` avant de partir', async () => {
    const r = await routeur();
    await r.executeCommand('debug ip packet');
    expect(String(await r.executeCommand('show debug'))).toContain('IP packet debugging is on');
    await r.executeCommand('no debug all');
    expect(String(await r.executeCommand('show debug'))).toContain('No debug flags are enabled');
  });

  it('piège 3 : un tampon de 128 Ko s\'annonce comme tel', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 131072 debugging');
    expect(String(await r.executeCommand('show logging'))).toContain('Log Buffer (131072 bytes)');
  });

  it('piège 5 : le tampon est circulaire — le trop-plein écrase les vieux', async () => {
    const r = await routeur();
    // Le plus petit tampon accepté, pour atteindre le plafond vite.
    await config(r, 'logging buffered 4096 debugging');
    for (let i = 0; i < 40; i++) {
      await config(r, 'interface GigabitEthernet0/0', 'shutdown', 'no shutdown');
    }
    const lignes = String(await r.executeCommand('show logging'))
      .split('\n').filter((l) => /^\*\w{3}/.test(l));
    // 40 cycles × 3 messages dépassent largement la capacité d'un 4 Ko.
    expect(lignes.length).toBeLessThan(120);
    expect(lignes.length).toBeGreaterThan(0);
  });

  it('piège 4 : sans `service timestamps`, la ligne n\'a pas d\'heure', async () => {
    const r = await routeur();
    await config(r, 'logging buffered 64000 debugging', 'no service timestamps log');
    await config(r, 'interface GigabitEthernet0/0', 'shutdown');
    const lignes = String(await r.executeCommand('show logging'))
      .split('\n').filter((l) => l.includes('%LINK'));
    expect(lignes.length).toBeGreaterThan(0);
    for (const l of lignes) expect(l).not.toMatch(/^\*\w{3}\s+\d+ \d{2}:\d{2}/);
  });
});

// ── Récapitulatif — la config de référence complète ─────────────────

describe('Récapitulatif — la configuration de référence tient en un bloc', () => {
  it('les seize lignes du récapitulatif passent, et se relisent', async () => {
    const r = await routeur();
    const bloc = [
      'service timestamps log datetime msec',
      'service timestamps debug datetime msec',
      'logging buffered 131072 debugging',
      'logging console notifications',
      'line console 0', 'logging synchronous', 'exit',
      'line vty 0 4', 'logging synchronous', 'exit',
      'logging host 192.168.1.100',
      'logging trap informational',
      'logging facility local7',
    ];
    // Le bloc est collé D'UN SEUL TENANT, comme on le colle sur un vrai
    // routeur : `logging synchronous` n'a de sens que dans la vue
    // `line` ouverte deux lignes plus haut, donc le découper en
    // sessions séparées ne testerait pas le récapitulatif du tutoriel.
    await r.executeCommand('configure terminal');
    for (const l of bloc) {
      expect(String(await r.executeCommand(l)), l).not.toMatch(REFUS);
    }
    await r.executeCommand('end');
    expect(String(await r.executeCommand('terminal monitor'))).not.toMatch(REFUS);

    const rc = String(await r.executeCommand('show running-config'));
    for (const attendu of ['service timestamps log datetime msec',
      'service timestamps debug datetime msec', 'logging buffered 131072 debugging',
      'logging console notifications', 'logging host 192.168.1.100', 'logging synchronous']) {
      expect(rc, attendu).toContain(attendu);
    }
  });
});
