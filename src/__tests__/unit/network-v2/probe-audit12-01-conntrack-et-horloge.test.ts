/**
 * Sondes — les manques de l'audit 12.
 *
 * Quatre manques, tous du même motif que le reste de la campagne : **le
 * moteur existait, la porte manquait.**
 *
 *  - `conntrack -L` / `-S` / `-C` / `-F` : `LinuxIptablesManager` tient
 *    une vraie table de suivi de connexions — c'est elle, et pas une
 *    approximation, qui décide si un paquet correspond à
 *    `-m state --state ESTABLISHED`. Rien ne la nommait.
 *  - `clock set` : `Router._setSystemClock` existait et `show clock` le
 *    lisait déjà via `getSystemClockMs`. On pouvait lire l'heure, jamais
 *    la corriger.
 *  - `ip address negotiated` : refusé avant même d'être reconnu, parce
 *    que le test de longueur passait avant.
 *  - `display port-security interface <if>` : la forme globale marchait,
 *    la forme par-interface non.
 *
 * **Le cas qui compte pour `conntrack` est le dernier scénario** : la
 * table doit se remplir de trafic RÉEL. Une commande qui rend toujours
 * « 0 flow entries » serait une coquille vide et passerait tous les
 * autres tests.
 *
 * Deux écarts assumés, écrits ici plutôt que découverts :
 *
 *  - Les compteurs de paquets/octets ne sont pas affichés — et c'est
 *    **le comportement par défaut du vrai binaire**, qui les demande via
 *    `net.netfilter.nf_conntrack_acct=1`, désactivé partout.
 *  - L'état ne connaît que `ESTABLISHED` et `[UNREPLIED]`. Le vrai
 *    conntrack suit la machine à états TCP complète ; le moteur derrière
 *    ne mémorise qu'un horodatage par tuple. Inventer `SYN_SENT` serait
 *    pire que n'en montrer que deux.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function serveur(): LinuxServer {
  const s = new LinuxServer('linux-server', 'srv1', 0, 0);
  s.powerOn();
  return s;
}

describe('Scénario 1 — `conntrack` répond, et refuse ce qui doit l\'être', () => {
  it('sans commande, le binaire réclame une commande', async () => {
    const s = serveur();
    const out = await s.executeCommand('conntrack');
    expect(out).toContain('conntrack v1.4.7 (conntrack-tools)');
    expect(out).toContain('missing command');
  });

  it('`-L` rend le récapitulatif du vrai binaire', async () => {
    const s = serveur();
    expect(await s.executeCommand('conntrack -L'))
      .toContain('flow entries have been shown.');
  });

  it('`-C` rend un nombre, `-S` la ligne de compteurs', async () => {
    const s = serveur();
    expect(await s.executeCommand('conntrack -C')).toMatch(/^\d+$/);
    const st = await s.executeCommand('conntrack -S');
    expect(st).toContain('cpu=0');
    expect(st).toContain('insert=');
    expect(st).toContain('found=');
  });

  it('`-F` vide la table et le dit', async () => {
    const s = serveur();
    expect(await s.executeCommand('conntrack -F'))
      .toContain('connection tracking table has been emptied.');
  });

  it('`which conntrack` s\'accorde avec le chemin déclaré', async () => {
    const s = serveur();
    expect(await s.executeCommand('which conntrack')).toBe('/usr/sbin/conntrack');
  });
});

describe('Scénario 2 — la table se remplit de trafic RÉEL', () => {
  it('un ping accepté crée un flux, visible par -L, -C et -S', async () => {
    EquipmentRegistry.resetInstance();
    const srv = serveur();
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    new Cable('c1').connect(srv.getPort('eth0')!, pc.getPort('eth0')!);
    await srv.executeCommand('sudo ip addr add 10.9.0.1/24 dev eth0');
    await pc.executeCommand('sudo ip addr add 10.9.0.2/24 dev eth0');

    const avant = parseInt(await srv.executeCommand('conntrack -C'), 10);
    // Le ping ARRIVE sur le serveur : `trackConnection` n'est appelé que
    // pour un paquet ENTRANT (ou routé) et accepté, ce qui est
    // exactement la règle de netfilter.
    await pingOnSimulatedClock(pc, 'ping -c 2 10.9.0.1');

    const apres = parseInt(await srv.executeCommand('conntrack -C'), 10);
    expect(apres).toBeGreaterThan(avant);

    const liste = await srv.executeCommand('conntrack -L');
    expect(liste).toContain('src=10.9.0.2');
    expect(liste).toContain('dst=10.9.0.1');
    expect(liste).toMatch(/icmp/);
    expect(liste).toContain('mark=0 use=1');

    // Les compteurs de `-S` sont les vrais, incrémentés au point
    // d'insertion — pas un affichage constant.
    expect(await srv.executeCommand('conntrack -S')).not.toContain('insert=0 ');

    // Et `-F` vide vraiment.
    await srv.executeCommand('conntrack -F');
    expect(parseInt(await srv.executeCommand('conntrack -C'), 10)).toBe(0);
  });

  it('`-p` filtre par protocole', async () => {
    EquipmentRegistry.resetInstance();
    const srv = serveur();
    const pc = new LinuxPC('linux-pc', 'pc2', 0, 0);
    pc.powerOn();
    new Cable('c2').connect(srv.getPort('eth0')!, pc.getPort('eth0')!);
    await srv.executeCommand('sudo ip addr add 10.9.1.1/24 dev eth0');
    await pc.executeCommand('sudo ip addr add 10.9.1.2/24 dev eth0');
    await pingOnSimulatedClock(pc, 'ping -c 1 10.9.1.1');

    expect(await srv.executeCommand('conntrack -L -p icmp')).toContain('src=10.9.1.2');
    // Aucun flux TCP n'a eu lieu : le filtre doit donc rendre zéro, pas
    // le flux ICMP.
    const tcp = await srv.executeCommand('conntrack -L -p tcp');
    expect(tcp).toContain('0 flow entries');
  });
});

describe('Scénario 3 — `clock set` corrige vraiment l\'heure', () => {
  async function routeur(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    return r;
  }

  it('l\'heure posée est celle que `show clock` rend ensuite', async () => {
    const r = await routeur();
    expect(await r.executeCommand('clock set 10:30:00 3 June 2026')).toBe('');
    const out = await r.executeCommand('show clock');
    expect(out).toContain('10:30:0');
    expect(out).toContain('Jun 3 2026');
  });

  it('les deux ordres d\'IOS sont acceptés', async () => {
    const r = await routeur();
    expect(await r.executeCommand('clock set 08:15:00 June 3 2026')).toBe('');
    expect(await r.executeCommand('show clock')).toContain('08:15:0');
  });

  it('une heure ou un mois impossible est refusé', async () => {
    const r = await routeur();
    expect(await r.executeCommand('clock set 99:99:99 3 June 2026')).toContain('Invalid input');
    expect(await r.executeCommand('clock set 10:30:00 3 Zzz 2026')).toContain('Invalid input');
    expect(await r.executeCommand('clock set 10:30:00 99 June 2026')).toContain('Invalid input');
  });

  it('une commande tronquée est signalée comme incomplète', async () => {
    const r = await routeur();
    expect(await r.executeCommand('clock set 10:30:00')).toBe('% Incomplete command.');
  });

  /**
   * La forme d'EXEC privilégié manquait, mais une forme en mode
   * CONFIGURATION existait déjà — et ne marchait pas : son analyseur
   * exigeait cinq mots là où la forme normale d'IOS en compte quatre.
   * Mesuré avant correction : `clock set 10:30:00 3 June 2026` en
   * `config` rendait la main sans rien changer, et seul un cinquième mot
   * parasite (`... 2027 extra`) posait vraiment l'heure. Une commande
   * acceptée qui ne fait rien est pire qu'un refus.
   *
   * Les deux modes passent maintenant par le MÊME analyseur : deux
   * lectures d'une seule commande finiraient par se contredire sur la
   * même date.
   */
  it('la forme en mode configuration pose la même heure, sur quatre mots', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('clock set 10:30:00 3 June 2026')).toBe('');
    await r.executeCommand('end');
    expect(await r.executeCommand('show clock')).toContain('Jun 3 2026');
  });

  it('les deux modes refusent la même chose', async () => {
    const r = await routeur();
    const privilegie = await r.executeCommand('clock set 99:99:99 3 June 2026');
    await r.executeCommand('configure terminal');
    const config = await r.executeCommand('clock set 99:99:99 3 June 2026');
    const message = (out: string): string => out.split('\n').pop() ?? '';
    const colonne = (out: string): number => out.split('\n')[0].indexOf('^');
    expect(message(config)).toBe(message(privilegie));
    expect(config).toContain('Invalid input');
    expect(colonne(config)).toBeGreaterThan(colonne(privilegie));
  });
});

describe('Scénario 4 — `ip address negotiated`', () => {
  async function iface(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R2');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    return r;
  }

  it('est accepté', async () => {
    const r = await iface();
    expect(await r.executeCommand('ip address negotiated')).toBe('');
  });

  it('n\'accepte rien après le mot-clé', async () => {
    const r = await iface();
    expect(await r.executeCommand('ip address negotiated extra')).toContain('Invalid input');
  });

  it('la forme numérique ordinaire marche toujours', async () => {
    const r = await iface();
    expect(await r.executeCommand('ip address 10.0.0.1 255.255.255.0')).toBe('');
    expect(await r.executeCommand('ip address 10.0.0.1')).toBe('% Incomplete command.');
  });
});

describe('Scénario 5 — `display port-security interface <if>`', () => {
  async function commute(): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'HW1', 26, 0, 0);
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('port-security enable');
    await sw.executeCommand('quit');
    await sw.executeCommand('quit');
    return sw;
  }

  it('filtre la MÊME vue que la forme globale', async () => {
    const sw = await commute();
    const global = await sw.executeCommand('display port-security');
    const un = await sw.executeCommand('display port-security interface GigabitEthernet0/0/1');
    // Deux tableaux qui pourraient se contredire seraient pires qu'un
    // seul : la forme par-interface filtre, elle ne recalcule pas.
    expect(un.split('\n')[0]).toBe(global.split('\n')[0]);
    expect(un).toContain('GigabitEthernet0/0/1');
    expect(un.split('\n')).toHaveLength(2);
  });

  it('un port sans port-security le dit, il n\'invente pas de ligne', async () => {
    const sw = await commute();
    expect(await sw.executeCommand('display port-security interface GigabitEthernet0/0/2'))
      .toBe('Port-security is not enabled on GigabitEthernet0/0/2.');
  });

  it('un port inexistant et un mot inconnu sont refusés', async () => {
    const sw = await commute();
    expect(await sw.executeCommand('display port-security interface Gi9/9/9'))
      .toContain("Wrong parameter found at '^' position");
    expect(await sw.executeCommand('display port-security zzz'))
      .toContain("Wrong parameter found at '^' position");
  });

  it('la forme globale est inchangée', async () => {
    const sw = await commute();
    const out = await sw.executeCommand('display port-security');
    expect(out).toContain('Port-security    MaxMac');
    expect(out).toContain('GigabitEthernet0/0/1');
  });
});
