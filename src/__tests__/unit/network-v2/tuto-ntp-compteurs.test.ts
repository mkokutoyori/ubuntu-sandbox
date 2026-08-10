/**
 * PRD-NTP-Tutoriel.md §10 / lot N8 — les compteurs de paquets NTP.
 *
 * ── Un refus a corriger, et c'est le mien ───────────────────────────
 *
 * Au lot N1, `show ntp packets` a ete REFUSEE au motif que « rien ne les
 * compte ». Le motif etait vrai du moteur ; la conclusion etait fausse.
 * **La commande existe sur IOS**, son format est documente
 * (« Ntp In packets », « Ntp Out packets », « Ntp bad version packets »,
 * « Ntp protocol error packets ») et elle accepte un filtre
 * `mode {active|client|passive|server}`. Refuser une vraie commande
 * parce que sa matiere manque revient a CACHER le manque plutot qu'a le
 * combler.
 *
 * ── Ce qui a ete verifie avant d'ecrire ─────────────────────────────
 *
 * Les trois formats viennent de leur documentation respective, jamais
 * d'une supposition :
 *
 * - **Cisco** : quatre lignes, et le filtre par mode ;
 * - **Huawei** : `display ntp-service statistics packet`, quinze
 *   compteurs sous un en-tete `NTP IPv4 Packet Statistical Information` ;
 * - **chrony** : `chronyc serverstats`, qui distingue les paquets NTP
 *   des paquets de COMMANDE.
 *
 * ── Ce qui est compte, et ce qui vaut zero pour de vrai ─────────────
 *
 * Six compteurs sont observes au point ou l'evenement a lieu. Les neuf
 * autres de la liste Huawei valent zero **parce que le mecanisme
 * n'existe pas** — pas de limiteur de debit, pas de file de traitement,
 * pas de plafond d'associations : aucun paquet n'a jamais PU etre
 * limite, retarde ou refuse pour ces motifs. Zero est la vraie valeur.
 *
 * La propriete centrale de ce fichier est une **identite** :
 * `recus = traites + ecartes`. Elle se verifie sans connaitre aucune
 * plateforme, et c'est elle qui distingue un comptage d'un affichage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/** Un serveur `ntp master 2` et un client Cisco, sur un vrai cable. */
async function paire(confServeur: string[] = [], confClient: string[] = []) {
  const srv = new CiscoRouter(`S${++serie}`);
  const cli = new CiscoRouter(`C${++serie}`);
  new Cable(`p${serie}`).connect(
    srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ntp master 2', ...confServeur, 'end']) await srv.executeCommand(c);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    ...confClient, 'ntp server 10.0.0.1', 'end']) await cli.executeCommand(c);
  return { srv, cli };
}

const lu = (sortie: string, champ: string): number =>
  parseInt(sortie.split('\n').find((l) => l.trim().startsWith(champ))
    ?.split(':')[1]?.trim() ?? '-1', 10);

describe('§8 — `show ntp packets` existe et mesure', () => {
  it('la commande n\'est plus refusee', async () => {
    // Elle repondait `% Invalid input detected` : mon propre refus du
    // lot N1, corrige ici.
    const { cli } = await paire();
    const out = await cli.executeCommand('show ntp packets');
    expect(out).not.toMatch(/Invalid input/);
    expect(out.split('\n')).toHaveLength(4);
  });

  it('les quatre lignes sont celles de la reference IOS', async () => {
    const { cli } = await paire();
    const out = await cli.executeCommand('show ntp packets');
    for (const champ of ['Ntp In packets:', 'Ntp Out packets:',
      'Ntp bad version packets:', 'Ntp protocol error packets:']) {
      expect(out, champ).toContain(champ);
    }
  });

  it('un echange fait bouger les compteurs des DEUX cotes', async () => {
    const { srv, cli } = await paire();
    const c = await cli.executeCommand('show ntp packets');
    const s = await srv.executeCommand('show ntp packets');
    // Le client a emis une requete et recu une reponse ; le serveur
    // l'inverse. Ce sont des mesures, pas des constantes.
    expect(lu(c, 'Ntp Out packets')).toBeGreaterThan(0);
    expect(lu(c, 'Ntp In packets')).toBeGreaterThan(0);
    expect(lu(s, 'Ntp In packets')).toBe(lu(c, 'Ntp Out packets'));
    expect(lu(s, 'Ntp Out packets')).toBe(lu(c, 'Ntp In packets'));
  });

  it('une machine qui n\'a rien echange compte zero', async () => {
    // Le temoin : sans zero de depart, une valeur non nulle ne prouve
    // rien.
    const r = new CiscoRouter(`Z${++serie}`);
    const out = await r.executeCommand('show ntp packets');
    expect(lu(out, 'Ntp In packets')).toBe(0);
    expect(lu(out, 'Ntp Out packets')).toBe(0);
  });

  it('chaque interrogation supplementaire incremente', async () => {
    const { cli } = await paire();
    const avant = lu(await cli.executeCommand('show ntp packets'), 'Ntp Out packets');
    cli.getNtpAgent().pollAll();
    const apres = lu(await cli.executeCommand('show ntp packets'), 'Ntp Out packets');
    expect(apres).toBe(avant + 1);
  });
});

describe('§8 — le filtre par mode', () => {
  it('ventile ce qui a ete recu', async () => {
    const { srv, cli } = await paire();
    // Le client a recu des reponses de SERVEUR ; le serveur des
    // requetes de CLIENT.
    expect(lu(await cli.executeCommand('show ntp packets mode server'), 'Ntp In packets'))
      .toBeGreaterThan(0);
    expect(lu(await srv.executeCommand('show ntp packets mode client'), 'Ntp In packets'))
      .toBeGreaterThan(0);
  });

  it('un mode sans trafic compte zero', async () => {
    const { cli } = await paire();
    expect(lu(await cli.executeCommand('show ntp packets mode passive'), 'Ntp In packets'))
      .toBe(0);
  });

  it('la somme des modes redonne le total', async () => {
    // C'est ce qui distingue une ventilation d'une invention.
    const { cli } = await paire();
    const total = lu(await cli.executeCommand('show ntp packets'), 'Ntp In packets');
    let somme = 0;
    for (const m of ['active', 'client', 'passive', 'server']) {
      somme += lu(await cli.executeCommand(`show ntp packets mode ${m}`), 'Ntp In packets');
    }
    expect(somme).toBe(total);
  });

  it('un mode inconnu est refuse', async () => {
    const { cli } = await paire();
    expect(await cli.executeCommand('show ntp packets mode zzz'))
      .toMatch(/% Invalid input detected/);
  });
});

describe('§8 — les compteurs distinguent les motifs de rejet', () => {
  it('une authentification qui echoue compte un rejet', async () => {
    // Le serveur authentifie, le client nomme la cle sans la connaitre.
    const { srv } = await paire(
      ['ntp authenticate', 'ntp authentication-key 1 md5 Secret', 'ntp trusted-key 1'],
      []);
    const c = srv.getNtpAgent().getCounters();
    expect(c.received).toBeGreaterThan(0);
    // Le client n'a pas signe : le serveur ecarte.
    expect(c.authFailures + c.dropped).toBeGreaterThan(0);
  });

  it('un refus d\'`access-group` compte un rejet, et le distingue', async () => {
    const { srv } = await paire(
      ['access-list 11 permit 192.168.99.0 0.0.0.255',
        'ntp access-group serve-only 11'], []);
    const c = srv.getNtpAgent().getCounters();
    expect(c.accessDenied).toBeGreaterThan(0);
    // Un refus d'acces n'est PAS un echec d'authentification : les deux
    // envoient l'operateur a deux endroits differents.
    expect(c.authFailures).toBe(0);
  });

  it('`recus = traites + ecartes`, quelle que soit la configuration', async () => {
    // L'identite qui fait de ces nombres un comptage plutot qu'un
    // affichage. Elle est verifiee sur quatre configurations.
    for (const [nom, confSrv] of [
      ['sans rien', []],
      ['avec authentification', ['ntp authenticate',
        'ntp authentication-key 1 md5 S', 'ntp trusted-key 1']],
      ['avec un access-group qui refuse', ['access-list 11 permit 192.168.99.0 0.0.0.255',
        'ntp access-group serve-only 11']],
      ['avec un access-group qui permet', ['access-list 10 permit any',
        'ntp access-group peer 10']],
    ] as const) {
      const { srv, cli } = await paire([...confSrv], []);
      for (const d of [srv, cli]) {
        const c = d.getNtpAgent().getCounters();
        expect(c.processed + c.dropped, `${nom} : ${d.name}`).toBe(c.received);
      }
    }
  });
});

describe('§8 — remettre a zero', () => {
  it('`clear ntp statistics` efface les compteurs', async () => {
    // Un compteur qu'on ne peut pas remettre a zero ne sert qu'a moitie :
    // un diagnostic commence par effacer, provoquer, relire.
    const { cli } = await paire();
    expect(lu(await cli.executeCommand('show ntp packets'), 'Ntp In packets'))
      .toBeGreaterThan(0);
    await cli.executeCommand('clear ntp statistics');
    const out = await cli.executeCommand('show ntp packets');
    expect(lu(out, 'Ntp In packets')).toBe(0);
    expect(lu(out, 'Ntp Out packets')).toBe(0);
  });

  it('et le comptage reprend ensuite', async () => {
    const { cli } = await paire();
    await cli.executeCommand('clear ntp statistics');
    cli.getNtpAgent().pollAll();
    expect(lu(await cli.executeCommand('show ntp packets'), 'Ntp Out packets')).toBe(1);
  });
});

describe('§8 — les trois plateformes lisent UN seul comptage', () => {
  it('Huawei rend le format de sa documentation', async () => {
    const srv = new CiscoRouter(`S${++serie}`);
    const hw = new HuaweiRouter(`H${++serie}`);
    new Cable(`q${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, hw.getPort('GE0/0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await srv.executeCommand(c);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.1.2 255.255.255.0', 'undo shutdown', 'quit',
      'ntp-service unicast-server 10.0.1.1', 'quit']) await hw.executeCommand(c);

    const out = await hw.executeCommand('display ntp-service statistics packet');
    expect(out).toContain('NTP IPv4 Packet Statistical Information');
    expect(lu(out, 'Sent')).toBeGreaterThan(0);
    expect(lu(out, 'Received')).toBeGreaterThan(0);
    // Les quinze compteurs du format sont la, y compris ceux que ce
    // moteur ne peut pas faire bouger — leur zero est vrai.
    for (const champ of ['Send failures', 'Rate-limited', 'Processing delay',
      'Interface disabled', 'Max dynamic association reached', 'Server disabled',
      'Others']) {
      expect(lu(out, champ), champ).toBe(0);
    }
  });

  it('`reset ntp-service statistics packet` efface aussi', async () => {
    const hw = new HuaweiRouter(`H${++serie}`);
    await hw.executeCommand('system-view');
    await hw.executeCommand('quit');
    expect(await hw.executeCommand('reset ntp-service statistics packet')).toBe('');
    expect(lu(await hw.executeCommand('display ntp-service statistics packet'), 'Sent'))
      .toBe(0);
  });

  it('chrony rend `serverstats`', async () => {
    const srv = new CiscoRouter(`S${++serie}`);
    const pc = new LinuxPC(`L${++serie}`);
    new Cable(`r${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await srv.executeCommand(c);
    await pc.executeCommand('ip addr add 10.0.2.2/24 dev eth0');
    await pc.executeCommand(
      "printf 'server 10.0.2.1 iburst\\n' | sudo tee /etc/chrony/chrony.conf");
    await pc.executeCommand('sudo systemctl restart chrony');

    const out = await pc.executeCommand('chronyc serverstats');
    expect(out).toContain('NTP packets received');
    expect(lu(out, 'NTP packets received')).toBeGreaterThan(0);
    // chrony distingue les paquets NTP des paquets de COMMANDE ; ce
    // simulateur n'a pas de socket de controle, donc ces deux-la sont a
    // zero pour de vrai.
    expect(lu(out, 'Command packets received')).toBe(0);
  });

  it('sans demon, `serverstats` parle au vide comme les autres', async () => {
    const pc = new LinuxPC(`L${++serie}`);
    await pc.executeCommand('sudo systemctl stop chrony');
    expect(await pc.executeCommand('chronyc serverstats'))
      .toBe('506 Cannot talk to daemon');
  });
});
