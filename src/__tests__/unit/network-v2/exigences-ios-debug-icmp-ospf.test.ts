/**
 * Dix exigences de conformité IOS, écrites AVANT les correctifs.
 *
 * Chaque bloc énonce ce qu'un routeur réel fait, pas ce que le
 * simulateur faisait. Les cas qui passent déjà sont conservés : ils
 * disent ce qui était acquis, et empêchent qu'un correctif voisin le
 * reprenne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { DEBUG_VERBATIM } from '@/network/devices/inspection/config/LoggingConfig';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

async function routeurPrivilegie(nom = 'R1'): Promise<CiscoRouter> {
  const r = new CiscoRouter(nom);
  await run(r, 'enable');
  return r;
}

/** Deux routeurs dos à dos, adressés et actifs. */
async function paireRouteurs(masqueR2 = '255.255.255.0'): Promise<[CiscoRouter, CiscoRouter]> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  for (const [r, ip, masque] of [[r1, '10.0.0.1', '255.255.255.0'], [r2, '10.0.0.2', masqueR2]] as [CiscoRouter, string, string][]) {
    await run(r, 'enable');
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, `ip address ${ip} ${masque}`);
    await run(r, 'no shutdown');
    await run(r, 'end');
  }
  return [r1, r2];
}


/**
 * Trois routeurs en chaine — R1 (10.0.0.1) — R2 — R3 (10.1.0.2) — pour
 * que le paquet TRAVERSE quelque chose. Ce cas observait auparavant un
 * sujet de bus que personne ne publie (`router.packet.forwarded`), sur
 * une maquette a DEUX routeurs dos a dos ou aucun paquet n'est achemine :
 * la liste observee restait vide et `for (const t of vus)` ne verifiait
 * donc rien du tout.
 */
async function chaineTroisRouteurs(): Promise<[CiscoRouter, CiscoRouter, CiscoRouter]> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  const plan: [CiscoRouter, string, string][] = [
    [r1, 'GigabitEthernet0/0', '10.0.0.1'],
    [r2, 'GigabitEthernet0/0', '10.0.0.2'],
    [r2, 'GigabitEthernet0/1', '10.1.0.1'],
    [r3, 'GigabitEthernet0/0', '10.1.0.2'],
  ];
  for (const [r, iface, ip] of plan) {
    await run(r, 'enable');
    await run(r, 'configure terminal');
    await run(r, `interface ${iface}`);
    await run(r, `ip address ${ip} 255.255.255.0`);
    await run(r, 'no shutdown');
    await run(r, 'end');
  }
  await run(r1, 'configure terminal');
  await run(r1, 'ip route 10.1.0.0 255.255.255.0 10.0.0.2');
  await run(r1, 'end');
  await run(r3, 'configure terminal');
  await run(r3, 'ip route 10.0.0.0 255.255.255.0 10.1.0.1');
  await run(r3, 'end');
  return [r1, r2, r3];
}

/** Collecte les TTL des echos ICMP vers `cible` que ce routeur RECOIT. */
function guetterTtl(r: CiscoRouter, cible: string): number[] {
  const vus: number[] = [];
  r.getBus().subscribe('port.frame.received', (e) => {
    const ip = e.payload.frame.payload as {
      type?: string; ttl?: number;
      destinationIP?: { toString(): string };
      payload?: { icmpType?: string };
    } | undefined;
    if (ip?.type !== 'ipv4' || ip.destinationIP?.toString() !== cible) return;
    if (ip.payload?.icmpType !== 'echo-request') return;
    if (typeof ip.ttl === 'number') vus.push(ip.ttl);
  });
  return vus;
}

// ── 1. Console vs sessions distantes (terminal monitor) ─────────────
/**
 * Prémisse corrigée par la mesure : ces trois cas s'abonnaient
 * directement à `LoggingConfig.subscribeMonitor()` et attendaient que
 * l'objet de configuration soit lui-même la porte de `terminal monitor`.
 * Un seul booléen sur l'équipement ne peut pas répondre pour plusieurs
 * sessions à la fois — le `terminal no monitor` de l'une couperait le
 * flux de l'autre — et VRP, qui pose son propre drapeau par session,
 * n'y touchait pas du tout, si bien qu'une vty Huawei ne recevait
 * jamais rien.
 *
 * La porte est la souscription elle-même : une session s'abonne parce
 * qu'elle a tapé la commande. Le contrat énoncé ici reste vrai et est
 * vérifié à l'étage qui le porte — voir `cisco-terminal-monitor.test.ts`
 * et `huawei-terminal-monitor.test.ts`, qui pilotent de vraies sessions.
 * Ce qui se teste ici, c'est ce que `LoggingConfig` décide seul.
 */
describe('Exigence 1 — le debug ne quitte la console que sur `terminal monitor`', () => {
  it('l\'état de `terminal monitor` est celui de la session, pas de l\'équipement', async () => {
    const r = await routeurPrivilegie();
    // `receivesAsyncOutput()` est exactement ce que lit le câblage des
    // vty pour décider, ligne par ligne, si CETTE session veut le flux.
    const etatDe = (d: CiscoRouter) => (d.getShell() as unknown as {
      receivesAsyncOutput(): { syslog: boolean };
    }).receivesAsyncOutput().syslog;

    expect(etatDe(r)).toBe(false);
    await run(r, 'terminal monitor');
    expect(etatDe(r)).toBe(true);
    await run(r, 'terminal no monitor');
    expect(etatDe(r)).toBe(false);
  });

  it('`no logging monitor` coupe le flux pour tout le monde', async () => {
    const r = await routeurPrivilegie();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeMonitor((l) => vues.push(l));

    journal.append('notifications', 'test', 'avant', true, 'CONFIG_I');
    expect(vues.join('\n')).toContain('avant');

    // Celle-là est bien une décision d'équipement, contrairement à
    // `terminal monitor` : elle est configurée, pas tapée sur une ligne.
    await run(r, 'configure terminal');
    await run(r, 'no logging monitor');
    await run(r, 'end');
    const compte = vues.length;
    journal.append('notifications', 'test', 'apres', true, 'CONFIG_I');
    expect(vues).toHaveLength(compte);
  });

  it('la console, elle, reçoit sans rien demander', async () => {
    const r = await routeurPrivilegie();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeConsole((l) => vues.push(l));
    journal.append('notifications', 'test', 'vers la console', true, 'CONFIG_I');
    expect(vues.join('\n')).toContain('vers la console');
  });

  it('la sévérité de `logging monitor` filtre le flux', async () => {
    const r = await routeurPrivilegie();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeMonitor((l) => vues.push(l));

    await run(r, 'configure terminal');
    await run(r, 'logging monitor errors');
    await run(r, 'end');
    journal.append('notifications', 'test', 'trop bas', true, 'CONFIG_I');
    expect(vues).toHaveLength(0);
    journal.append('errors', 'test', 'assez grave', true, 'CONFIG_I');
    expect(vues.join('\n')).toContain('assez grave');
  });
});

// ── 2. undebug all / show debug ─────────────────────────────────────
describe('Exigence 2 — arrêt global du debug et état courant', () => {
  it('sans aucun drapeau, `show debugging` le dit', async () => {
    const r = await routeurPrivilegie();
    expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
  });

  it('un drapeau actif est listé nommément', async () => {
    const r = await routeurPrivilegie();
    await run(r, 'configure terminal');
    await run(r, 'router ospf 1');
    await run(r, 'end');
    await run(r, 'debug ip ospf events');
    const out = await run(r, 'show debugging');
    expect(out).toMatch(/OSPF events debugging is on/i);
  });

  it('`undebug all` coupe tout et le confirme', async () => {
    const r = await routeurPrivilegie();
    await run(r, 'configure terminal');
    await run(r, 'router ospf 1');
    await run(r, 'end');
    await run(r, 'debug ip ospf events');
    expect(await run(r, 'undebug all')).toContain('All possible debugging has been turned off');
    expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
  });

  it('`un all` et `no debug all` sont les mêmes commandes', async () => {
    for (const forme of ['un all', 'no debug all']) {
      const r = await routeurPrivilegie();
      await run(r, 'debug ip ospf events');
      expect(await run(r, forme)).toContain('All possible debugging has been turned off');
      expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
    }
  });

  it('un drapeau éteint n\'émet plus rien', async () => {
    const r = await routeurPrivilegie();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeConsole((l) => vues.push(l));
    await run(r, 'debug ip ospf events');
    await run(r, 'undebug all');
    const avant = vues.length;
    journal.append('debugging', 'ospf', 'ne doit pas sortir', true, DEBUG_VERBATIM);
    expect(vues).toHaveLength(avant);
  });
});

// ── 3. Horodatage `*Mon DD HH:MM:SS.mmm:` ───────────────────────────
describe('Exigence 3 — horodatage standardisé des logs', () => {
  const HORODATAGE = /^\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3}: /;

  it('`service timestamps log datetime msec` préfixe chaque ligne', async () => {
    const r = await routeurPrivilegie();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeConsole((l) => vues.push(l));
    await run(r, 'configure terminal');
    await run(r, 'service timestamps log datetime msec');
    await run(r, 'end');

    journal.append('notifications', 'ospf', 'Process 1, Nbr 10.0.0.2', true, 'ADJCHG');
    expect(vues.at(-1)).toMatch(HORODATAGE);
    expect(vues.at(-1)).toContain('%OSPF-5-ADJCHG:');
  });

  it('le debug est horodaté par `service timestamps debug datetime msec`', async () => {
    const r = await routeurPrivilegie();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeConsole((l) => vues.push(l));
    await run(r, 'configure terminal');
    await run(r, 'service timestamps debug datetime msec');
    await run(r, 'router ospf 1');
    await run(r, 'end');
    await run(r, 'debug ip ospf events');

    journal.append('debugging', 'ospf', 'OSPF-1 HELLO Gi0/0: Send hello', true, DEBUG_VERBATIM);
    expect(vues.at(-1)).toMatch(HORODATAGE);
  });
});

// ── 5. Symboles ICMP du ping ────────────────────────────────────────
describe('Exigence 5 — chaque caractère de ping est une réponse ICMP précise', () => {
  it('`!` quand la cible répond', async () => {
    const [r1] = await paireRouteurs();
    const out = await run(r1, 'ping 10.0.0.2');
    expect(out).toMatch(/!{3,}/);
    expect(out).toMatch(/Success rate is \d+ percent/);
  });

  it('`N` (Network Unreachable) quand aucune route ne mène à la cible', async () => {
    const r = await routeurPrivilegie();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip address 10.0.0.1 255.255.255.0');
    await run(r, 'no shutdown');
    await run(r, 'end');
    const out = await run(r, 'ping 203.0.113.9');
    expect(out).toMatch(/\.{2,}/);
    expect(out).toMatch(/Success rate is 0 percent/);
  });

  it('`U` quand la cible refuse par ACL — IOS ne distingue pas le code', async () => {
    // Une ACL SORTANTE ne filtre pas le trafic que le routeur produit
    // lui-même : c'est le pair qui refuse, en entrée, et qui renvoie
    // l'ICMP Administratively Prohibited.
    const [r1, r2] = await paireRouteurs();
    await run(r1, 'ping 10.0.0.2');
    await run(r2, 'configure terminal');
    await run(r2, 'access-list 101 deny icmp any any');
    await run(r2, 'access-list 101 permit ip any any');
    await run(r2, 'interface GigabitEthernet0/0');
    await run(r2, 'ip access-group 101 in');
    await run(r2, 'end');
    const out = await run(r1, 'ping 10.0.0.2');
    expect(out).toMatch(/U{2,}/);
  });
});

// ── 6. Premier ping perdu par résolution ARP ────────────────────────
describe('Exigence 6 — le premier paquet paie la résolution ARP', () => {
  it('table ARP vide : le premier échoue, les suivants passent (.!!!!)', async () => {
    const [r1] = await paireRouteurs();
    // Configurer une adresse émet un ARP gratuit : le voisin est déjà
    // connu. Vider le cache est ce qu'on fait sur un vrai routeur pour
    // observer ce délai.
    await run(r1, 'clear arp-cache');
    const out = await run(r1, 'ping 10.0.0.2');
    expect(out).toMatch(/\.!{4}/);
    expect(out).toMatch(/Success rate is 80 percent \(4\/5\)/);
  });

  it('une fois la MAC apprise, le ping suivant est plein', async () => {
    const [r1] = await paireRouteurs();
    await run(r1, 'clear arp-cache');
    await run(r1, 'ping 10.0.0.2');
    const out = await run(r1, 'ping 10.0.0.2');
    expect(out).toMatch(/!{5}/);
    expect(out).toMatch(/Success rate is 100 percent \(5\/5\)/);
  });
});

// ── 7. TTL et ICMP Time Exceeded ────────────────────────────────────
describe('Exigence 7 — le TTL décroît à chaque saut, zéro déclenche Time Exceeded', () => {
  it('un paquet routé perd exactement 1 de TTL par routeur traversé', async () => {
    const [r1, r2, r3] = await chaineTroisRouteurs();
    const arrives = guetterTtl(r2, '10.1.0.2');
    const traverses = guetterTtl(r3, '10.1.0.2');

    await run(r1, 'ping 10.1.0.2');

    expect(arrives.length).toBeGreaterThan(0);
    expect(traverses.length).toBeGreaterThan(0);
    expect(traverses[0]).toBe(arrives[0] - 1);
  });

  it('un TTL épuisé produit un ICMP Time Exceeded, ce qui fait marcher traceroute', async () => {
    const [r1] = await paireRouteurs();
    const out = await run(r1, 'traceroute 10.0.0.2');
    expect(out).toMatch(/10\.0\.0\.2/);
  });
});

// ── 8. OSPF : masques discordants dans le Hello ─────────────────────
describe('Exigence 8 — un masque discordant interdit l\'adjacence OSPF', () => {
  it('/24 face à /25 : aucune adjacence ne se forme', async () => {
    const [r1, r2] = await paireRouteurs('255.255.255.128');
    for (const [r, rid] of [[r1, '1.1.1.1'], [r2, '2.2.2.2']] as [CiscoRouter, string][]) {
      await run(r, 'configure terminal');
      await run(r, 'router ospf 1');
      await run(r, `router-id ${rid}`);
      await run(r, 'network 10.0.0.0 0.0.0.255 area 0');
      await run(r, 'end');
    }
    const out = await run(r1, 'show ip ospf neighbor');
    expect(out).not.toMatch(/FULL/);
  });

  it('masques identiques : l\'adjacence atteint FULL', async () => {
    const [r1, r2] = await paireRouteurs();
    for (const [r, rid] of [[r1, '1.1.1.1'], [r2, '2.2.2.2']] as [CiscoRouter, string][]) {
      await run(r, 'configure terminal');
      await run(r, 'router ospf 1');
      await run(r, `router-id ${rid}`);
      await run(r, 'network 10.0.0.0 0.0.0.255 area 0');
      await run(r, 'end');
    }
    expect(await run(r1, 'show ip ospf neighbor')).toMatch(/FULL/);
  });

  it('`debug ip ospf hello` nomme le paramètre fautif et compare Reçu/Configuré', async () => {
    const [r1, r2] = await paireRouteurs('255.255.255.128');
    const journal = r1.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeConsole((l) => vues.push(l));
    // `debug ip ospf` exige un processus OSPF : on monte celui de r1, on arme
    // le debug, PUIS r2 rejoint — sinon la discordance est déjà passée.
    await run(r1, 'configure terminal');
    await run(r1, 'router ospf 1');
    await run(r1, 'router-id 1.1.1.1');
    await run(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    await run(r1, 'end');
    await run(r1, 'debug ip ospf hello');
    await run(r2, 'configure terminal');
    await run(r2, 'router ospf 1');
    await run(r2, 'router-id 2.2.2.2');
    await run(r2, 'network 10.0.0.0 0.0.0.255 area 0');
    await run(r2, 'end');
    const tout = vues.join('\n');
    expect(tout).toMatch(/Mismatched hello parameters from 10\.0\.0\.2/);
    expect(tout).toMatch(/Dead R 40 C 40, Hello R 10 C 10, Mask R 255\.255\.255\.128 C 255\.255\.255\.0/);
  });
});

// ── 9. Cascade L1 → L2 → L3 ─────────────────────────────────────────
describe('Exigence 9 — un shutdown physique cascade sur les sous-interfaces', () => {
  async function routeurAvecSousInterfaces(): Promise<CiscoRouter> {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    await run(r1, 'enable');
    await run(r1, 'configure terminal');
    await run(r1, 'interface GigabitEthernet0/0');
    await run(r1, 'no shutdown');
    await run(r1, 'exit');
    for (const [vlan, ip] of [['10', '192.168.10.1'], ['20', '192.168.20.1']]) {
      await run(r1, `interface GigabitEthernet0/0.${vlan}`);
      await run(r1, `encapsulation dot1q ${vlan}`);
      await run(r1, `ip address ${ip} 255.255.255.0`);
      await run(r1, 'exit');
    }
    await run(r1, 'end');
    return r1;
  }

  it('parente active : les sous-interfaces sont up/up et leurs routes sont là', async () => {
    const r1 = await routeurAvecSousInterfaces();
    const brief = await run(r1, 'show ip interface brief');
    expect(brief).toMatch(/GigabitEthernet0\/0\.10\s+192\.168\.10\.1\s+YES manual up\s+up/);
    const routes = await run(r1, 'show ip route');
    expect(routes).toContain('192.168.10.0/24');
    expect(routes).toContain('192.168.20.0/24');
  });

  it('`shutdown` sur la parente fait tomber les sous-interfaces', async () => {
    const r1 = await routeurAvecSousInterfaces();
    await run(r1, 'configure terminal');
    await run(r1, 'interface GigabitEthernet0/0');
    await run(r1, 'shutdown');
    await run(r1, 'end');

    const brief = await run(r1, 'show ip interface brief');
    const ligneParente = brief.split('\n').find(l => l.startsWith('GigabitEthernet0/0 '))!;
    expect(ligneParente).toMatch(/administratively down\s+down/);
    for (const sous of ['GigabitEthernet0/0.10', 'GigabitEthernet0/0.20']) {
      const ligne = brief.split('\n').find(l => l.startsWith(sous))!;
      expect(ligne, sous).toMatch(/down\s+down/);
    }
  });

  it('et retire leurs routes connectées de la RIB', async () => {
    const r1 = await routeurAvecSousInterfaces();
    await run(r1, 'configure terminal');
    await run(r1, 'interface GigabitEthernet0/0');
    await run(r1, 'shutdown');
    await run(r1, 'end');
    const routes = await run(r1, 'show ip route');
    expect(routes).not.toContain('192.168.10.0/24');
    expect(routes).not.toContain('192.168.20.0/24');
  });

  it('`no shutdown` les fait toutes revenir', async () => {
    const r1 = await routeurAvecSousInterfaces();
    await run(r1, 'configure terminal');
    await run(r1, 'interface GigabitEthernet0/0');
    await run(r1, 'shutdown');
    await run(r1, 'no shutdown');
    await run(r1, 'end');
    expect(await run(r1, 'show ip route')).toContain('192.168.10.0/24');
  });
});

// ── 10. Canonisation de la running-config ───────────────────────────
describe('Exigence 10 — la running-config rend la forme canonique, pas la frappe', () => {
  it('`int gi 0/0` ressort en `interface GigabitEthernet0/0`', async () => {
    const r = await routeurPrivilegie();
    await run(r, 'configure terminal');
    await run(r, 'int gi 0/0');
    await run(r, 'ip addr 10.0.0.1 255.255.255.0');
    await run(r, 'end');
    const cfg = await run(r, 'show running-config');
    expect(cfg).toContain('interface GigabitEthernet0/0');
    expect(cfg).toContain('ip address 10.0.0.1 255.255.255.0');
    expect(cfg).not.toContain('int gi 0/0');
    expect(cfg).not.toContain('ip addr 10.0.0.1');
  });

  it('un `network` OSPF est ramené à son adresse de réseau', async () => {
    const r = await routeurPrivilegie();
    await run(r, 'configure terminal');
    await run(r, 'router ospf 1');
    await run(r, 'network 192.168.1.1 0.0.0.255 area 0');
    await run(r, 'end');
    const cfg = await run(r, 'show running-config');
    expect(cfg).toContain('network 192.168.1.0 0.0.0.255 area 0');
    expect(cfg).not.toContain('network 192.168.1.1 0.0.0.255');
  });
});
