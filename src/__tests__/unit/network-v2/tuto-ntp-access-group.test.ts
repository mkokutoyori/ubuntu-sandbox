/**
 * PRD-NTP-Tutoriel.md §8 / lot N6 — `ntp access-group` filtre pour de
 * bon.
 *
 * Les quatre groupes etaient acceptes, ranges et rendus dans la
 * configuration, et **aucune ACL n'etait consultee a la reception d'un
 * paquet NTP**. Le durcissement des §3.7 et §9 du tutoriel n'avait aucun
 * effet observable — la forme de defaut que ce depot ferme partout.
 *
 * ── Ce qui a ete verifie contre la documentation constructeur ───────
 *
 * 1. **Les quatre mots-cles et ce que chacun permet** (reference de
 *    commandes IOS) : `peer` autorise tout et **la synchronisation**,
 *    `serve` autorise l'heure et les requetes de controle sans la
 *    synchronisation, `serve-only` l'heure seule, `query-only` les
 *    requetes de controle seules.
 * 2. **`nomodify` n'est PAS un mot-cle IOS** — c'est la syntaxe de
 *    `ntpd`/`chrony`. Le tutoriel l'emploie ; ce fichier verifie qu'il
 *    est REFUSE, parce qu'une commande acceptee ici apprendrait une
 *    syntaxe que la vraie machine rejette.
 * 3. **L'ordre va du moins au plus restrictif** — `peer`, `serve`,
 *    `serve-only`, `query-only` — et le premier groupe dont l'ACL
 *    accepte la source decide. Une page Cisco place `query-only` en
 *    deuxieme ; deux autres sources le placent en quatrieme, seul ordre
 *    coherent avec « du moins au plus restrictif ». C'est celui-la.
 * 4. **Aucun groupe = acces complet ; un seul groupe = seulement ce
 *    qu'il accorde.** C'est le piege que le §3.7 tend sans le dire, et
 *    le cas le plus instructif du fichier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  ORDRE_ACCES, estGenreAcces, verdictAccesNtp,
} from '@/network/ntp/accessGroups';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/**
 * Un serveur `ntp master 2` et un client, sur un vrai cable. Le serveur
 * porte les listes et les groupes qu'on lui donne.
 */
async function labo(acl: string[], groupes: string[]) {
  const srv = new CiscoRouter(`S${++serie}`);
  const cli = new CiscoRouter(`C${++serie}`);
  new Cable(`g${serie}`).connect(
    srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ntp master 2', ...acl, ...groupes, 'end']) await srv.executeCommand(c);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ntp server 10.0.0.1', 'end']) await cli.executeCommand(c);
  return { srv, cli };
}

const PERMET = ['access-list 10 permit 10.0.0.0 0.0.0.255'];
const REFUSE = ['access-list 11 permit 192.168.99.0 0.0.0.255'];
const synchronise = (s: string) => /^Clock is synchronized/.test(s);

describe('le serveur filtre qui a le droit de demander l\'heure', () => {
  it('sans aucun groupe, tout le monde est servi', async () => {
    // « If no access groups are specified, comprehensive access is
    // granted to all sources. »
    const { cli } = await labo([], []);
    expect(synchronise(await cli.executeCommand('show ntp status'))).toBe(true);
  });

  it('`serve-only` avec une ACL qui PERMET : le client se synchronise', async () => {
    const { cli } = await labo(PERMET, ['ntp access-group serve-only 10']);
    expect(await cli.executeCommand('show ntp status')).toMatch(/stratum 3/);
  });

  it('`serve-only` avec une ACL qui REFUSE : le client reste seul', async () => {
    // Le cas central. Il se synchronisait quand meme.
    const { cli } = await labo(REFUSE, ['ntp access-group serve-only 11']);
    const st = await cli.executeCommand('show ntp status');
    expect(synchronise(st)).toBe(false);
    expect(st).toMatch(/stratum 16/);
  });

  it('`query-only` n\'autorise PAS une requete de temps', async () => {
    // C'est ce qui distingue `query-only` de `serve-only`, et la raison
    // pour laquelle il est le plus restrictif des quatre.
    const { cli } = await labo(PERMET, ['ntp access-group query-only 10']);
    expect(synchronise(await cli.executeCommand('show ntp status'))).toBe(false);
  });

  it('`serve` et `peer` autorisent la requete de temps', async () => {
    for (const genre of ['serve', 'peer']) {
      const { cli } = await labo(PERMET, [`ntp access-group ${genre} 10`]);
      expect(await cli.executeCommand('show ntp status'), genre).toMatch(/stratum 3/);
    }
  });

  it('une source qu\'aucun groupe ne reconnait est ecartee', async () => {
    // Deux groupes poses, aucun ne couvrant le client.
    const { cli } = await labo(REFUSE,
      ['ntp access-group serve-only 11', 'ntp access-group peer 11']);
    expect(synchronise(await cli.executeCommand('show ntp status'))).toBe(false);
  });
});

describe('§3.7 — le piege : `serve-only` empeche le routeur de se synchroniser', () => {
  it('un routeur en `serve-only` sert l\'heure et n\'en recoit pas', async () => {
    // Se SYNCHRONISER demande `peer`. Un `serve-only` seul laisse la
    // machine servir tout en la coupant de ses propres sources — c'est
    // le piege que le §3.7 tend sans le dire, et il est desormais
    // reproductible.
    const amont = new CiscoRouter(`A${++serie}`);
    const milieu = new CiscoRouter(`M${++serie}`);
    const aval = new CiscoRouter(`V${++serie}`);
    new Cable(`h${serie}`).connect(
      amont.getPort('GigabitEthernet0/0')!, milieu.getPort('GigabitEthernet0/0')!);
    new Cable(`i${serie}`).connect(
      milieu.getPort('GigabitEthernet0/1')!, aval.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await amont.executeCommand(c);
    for (const c of ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.2.0.1 255.255.255.0', 'no shutdown', 'exit',
      'access-list 20 permit any', 'ntp access-group serve-only 20',
      'ntp master 5', 'ntp server 10.1.0.1', 'end']) await milieu.executeCommand(c);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.2.0.2 255.255.255.0', 'no shutdown', 'exit',
      'ntp server 10.2.0.1', 'end']) await aval.executeCommand(c);

    // Le milieu SERT toujours : l'aval l'atteint.
    expect(await aval.executeCommand('show ntp status')).toMatch(/stratum 6/);
    // Mais il ne se synchronise pas sur l'amont : il reste a son propre
    // stratum de maitre local, au lieu de descendre a 3.
    expect(await milieu.executeCommand('show ntp status')).toMatch(/stratum 5/);
  });

  it('avec `peer` en plus, le meme routeur se synchronise', async () => {
    // La correction que le §3.7 devrait enseigner : ajouter `peer`.
    const amont = new CiscoRouter(`A${++serie}`);
    const milieu = new CiscoRouter(`M${++serie}`);
    new Cable(`j${serie}`).connect(
      amont.getPort('GigabitEthernet0/0')!, milieu.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await amont.executeCommand(c);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
      'access-list 20 permit any', 'ntp access-group serve-only 20',
      'ntp access-group peer 20', 'ntp server 10.1.0.1', 'end']) {
      await milieu.executeCommand(c);
    }
    expect(await milieu.executeCommand('show ntp status')).toMatch(/stratum 3/);
  });
});

describe('la grammaire est celle d\'IOS, pas celle de ntpd', () => {
  it('`nomodify` est REFUSE', async () => {
    // Le tutoriel ecrit `ntp access-group nomodify 10`. C'est la syntaxe
    // de `ntpd` et de `chrony` ; IOS ne connait que quatre familles.
    const r = new CiscoRouter(`N${++serie}`);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('ntp access-group nomodify 10'))
      .toMatch(/% Invalid input detected/);
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('nomodify');
  });

  it('les quatre familles d\'IOS sont acceptees et se relisent', async () => {
    const r = new CiscoRouter(`N${++serie}`);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const g of ORDRE_ACCES) {
      expect(await r.executeCommand(`ntp access-group ${g} 10`), g).toBe('');
    }
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    for (const g of ORDRE_ACCES) expect(cfg, g).toContain(`ntp access-group ${g} 10`);
  });

  it('`estGenreAcces` reconnait les quatre et rien d\'autre', () => {
    for (const g of ORDRE_ACCES) expect(estGenreAcces(g), g).toBe(true);
    for (const faux of ['nomodify', 'notrap', 'noquery', 'kod', 'limited', '']) {
      expect(estGenreAcces(faux), faux).toBe(false);
    }
  });
});

describe('la table de permissions est celle de la documentation', () => {
  const tout = (g: string, acl = 'A') => new Map([[g, acl]]);
  const oui = () => true;

  it('`peer` autorise les trois actions, dont la synchronisation', () => {
    for (const a of ['serve-time', 'control-query', 'sync-from'] as const) {
      expect(verdictAccesNtp(tout('peer'), a, oui), a).toBe(true);
    }
  });

  it('`serve` autorise tout SAUF la synchronisation', () => {
    expect(verdictAccesNtp(tout('serve'), 'serve-time', oui)).toBe(true);
    expect(verdictAccesNtp(tout('serve'), 'control-query', oui)).toBe(true);
    expect(verdictAccesNtp(tout('serve'), 'sync-from', oui)).toBe(false);
  });

  it('`serve-only` n\'autorise QUE la requete de temps', () => {
    expect(verdictAccesNtp(tout('serve-only'), 'serve-time', oui)).toBe(true);
    expect(verdictAccesNtp(tout('serve-only'), 'control-query', oui)).toBe(false);
    expect(verdictAccesNtp(tout('serve-only'), 'sync-from', oui)).toBe(false);
  });

  it('`query-only` n\'autorise QUE la requete de controle', () => {
    expect(verdictAccesNtp(tout('query-only'), 'control-query', oui)).toBe(true);
    expect(verdictAccesNtp(tout('query-only'), 'serve-time', oui)).toBe(false);
    expect(verdictAccesNtp(tout('query-only'), 'sync-from', oui)).toBe(false);
  });

  it('le PREMIER groupe dont l\'ACL accepte la source decide', () => {
    // `peer` vient avant `serve-only` : une source acceptee par les deux
    // obtient les droits de `peer`, y compris la synchronisation.
    const deux = new Map([['serve-only', 'A'], ['peer', 'B']]);
    expect(verdictAccesNtp(deux, 'sync-from', oui)).toBe(true);
    // Si seule l'ACL de `serve-only` accepte, c'est elle qui decide, et
    // la synchronisation est refusee.
    expect(verdictAccesNtp(deux, 'sync-from', (acl) => acl === 'A')).toBe(false);
  });

  it('l\'ordre declare est celui du moins au plus restrictif', () => {
    expect([...ORDRE_ACCES]).toEqual(['peer', 'serve', 'serve-only', 'query-only']);
  });

  it('aucun groupe : tout est permis ; un groupe qui ne matche pas : rien', () => {
    expect(verdictAccesNtp(new Map(), 'sync-from', () => false)).toBe(true);
    expect(verdictAccesNtp(tout('peer'), 'sync-from', () => false)).toBe(false);
  });
});
