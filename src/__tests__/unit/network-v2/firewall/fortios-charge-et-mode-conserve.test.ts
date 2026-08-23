/**
 * La CHARGE est mesuree, et le mode conserve engage vraiment.
 *
 * §6.5 du carnet nomme le point : « `get system performance status` ne rend
 * ni CPU ni memoire : aucun modele de charge n'existe, et une constante
 * affichee la ou la vue promet une mesure est precisement le defaut que ce
 * depot referme. »
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. Un equipement DEMARRE occupe une partie de sa memoire. Zero
 *      utilise veut dire qu'il n'a pas demarre.
 *   2. Les parts de la ligne `Memory:` decrivent la MEME machine :
 *      utilise + libre + liberable = total. Ce sont TROIS categories
 *      disjointes et non deux dont l'une contiendrait l'autre — la
 *      capture d'un vrai boitier le tranche, 68,6 + 18,8 + 12,6 = 100.
 *   3. Ce que l'equipement PORTE pese, et la mesure suit : declarer des
 *      objets, reserver un tampon de journaux, ouvrir des sessions font
 *      monter la memoire utilisee ; rendre le tampon la fait redescendre.
 *   4. Le tampon de journaux est une RESERVE : une fois reservee, la
 *      remplir ne change RIEN — un tampon circulaire est alloue une
 *      fois, pas agrandi enregistrement par enregistrement, et la RAM
 *      qu'il occupe n'est pas reclamable puisque la liberer perdrait
 *      les journaux.
 *   5. Ce que l'equipement FAIT pese sur le CPU : la vue mesure un DEBIT
 *      sur une fenetre glissante, et le silence ramene l'inactivite a
 *      cent pour cent.
 *   6. Le nombre de CPU et la RAM viennent du CHASSIS, une seule fois :
 *      `get system status` et `get system performance status` ne peuvent
 *      pas se contredire.
 *   7. Les seuils du mode conserve se REGLENT
 *      (`memory-use-threshold-red|green|extreme` sous `config system
 *      global`), et la vue rend le seuil regle et non une constante.
 *   8. Le mode conserve s'ALLUME au seuil rouge et ne se relache qu'au
 *      seuil VERT — une hysteresis, pas un seuil unique.
 *   9. Il a une CONSEQUENCE : au seuil extreme une NOUVELLE session est
 *      refusee, une session deja etablie continue de passer. Un mode
 *      conserve qui ne change rien au trafic serait une ligne de plus.
 *  10. L'entree et la sortie sont JOURNALISEES.
 *  11. `diagnose sys top` rend le %CPU et le %memoire de chaque
 *      processus, pas `0.0 0.0` en dur.
 *
 * Le LEVIER de pression memoire est une vraie commande d'operateur :
 * `config log memory global-setting` / `set max-size`. Sur un vrai
 * FortiGate ce tampon est de la RAM reservee, et le sur-dimensionner est
 * une cause documentee de mode conserve. Aucune porte derobee de test
 * n'est ouverte dans l'equipement.
 *
 * Ce qui reste a ZERO et est dit ici plutot que decouvert : `nice`,
 * `iowait` et `irq` ne correspondent a rien que ce simulateur mesure,
 * donc ils valent zero. Les inventer serait le defaut qu'on referme.
 *
 * Discrimination (`git stash push -- src/network/`) : 15 des 24 cas
 * tombent avant correctif. Les 9 autres sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve le mecanisme :
 *   - les DEUX cas de modele (`new SystemLoad(...)`) passent des deux
 *     cotes parce que `git stash` ne touche pas un fichier NEUF non
 *     suivi : le modele n'est pas revenu en arriere, seul son cablage
 *     l'est. Ils eprouvent l'arithmetique, pas l'equipement ;
 *   - « les parts de la ligne Memory » passait parce que l'ancienne
 *     constante rendait 0 utilise, total libre, 0 liberable — la somme
 *     tombait juste pour la mauvaise raison ;
 *   - « remplir un tampon deja reserve ne change rien » passait parce
 *     que RIEN n'etait mesure, donc rien ne pouvait changer ;
 *   - « la RAM du chassis est declaree une seule fois » passait parce
 *     que les DEUX declarations en dur portaient le meme 1985 : elles
 *     coincidaient sans etre reliees ;
 *   - « au repos, cent pour cent d'inactivite » et « une ligne par CPU »
 *     passaient parce que la constante gelee valait exactement cela ;
 *   - « le mode conserve est arrete au repos » passait parce que la
 *     memoire utilisee etait nulle, donc le mode ne pouvait JAMAIS
 *     s'allumer — c'est le defaut, pas la conformite ;
 *   - « un seuil hors bornes est refuse » passait parce que le mot-cle
 *     entier etait refuse, faute d'exister.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { SystemLoad } from '@/network/devices/firewall/health/SystemLoad';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const CLIENT = '203.0.113.10';
const SERVEUR = '192.168.1.10';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

let horloge = 1_700_000_000_000;
function avance(ms: number): void { horloge += ms; }

async function runOn(
  machine: LinuxPC | LinuxServer, commands: readonly string[],
): Promise<void> {
  for (const command of commands) await machine.executeCommand(command);
}

function pareFeu() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  horloge = 1_700_000_000_000;
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => horloge });
  return { fw, sh: fw.getShell() };
}

async function laboratoire() {
  const { fw, sh } = pareFeu();
  const client = new LinuxPC('linux-pc', 'PC', 200, 0);
  const serveur = new LinuxServer('linux-server', 'WEB', -200, 0);
  for (const d of [client, serveur]) d.powerOn();

  new Cable('a').connect(fw.getPort('port1')!, serveur.getPorts()[0]);
  new Cable('b').connect(fw.getPort('port2')!, client.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');
  run(sh,
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');

  await runOn(serveur, ['ip link set eth0 up', `ip addr add ${SERVEUR}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(client, ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);

  return { fw, sh, client, serveur };
}

function nombre(texte: string, motif: RegExp): number {
  const trouve = motif.exec(texte);
  expect(trouve, `${motif} introuvable dans :\n${texte}`).not.toBeNull();
  return Number.parseFloat(trouve?.[1] ?? '');
}

function memoire(sh: FortiShell) {
  const vue = run(sh, 'get system performance status');
  return {
    total: nombre(vue, /Memory: (\d+)k total/),
    utilisee: nombre(vue, /(\d+)k used/),
    libre: nombre(vue, /(\d+)k free/),
    liberable: nombre(vue, /(\d+)k freeable/),
    pourcentUtilise: nombre(vue, /used \((\d+\.\d)%\)/),
  };
}

function inactivite(sh: FortiShell): number {
  return nombre(run(sh, 'get system performance status'), /CPU states:[^\n]*?(\d+)% idle/);
}

function reserverJournal(sh: FortiShell, octets: number): string {
  return run(sh, 'config log memory global-setting', `set max-size ${octets}`, 'end');
}

interface SocleMemoire {
  readonly total: number;
  readonly utilisee: number;
}

function socleMemoire(sh: FortiShell): SocleMemoire {
  const mesure = memoire(sh);
  return { total: mesure.total, utilisee: mesure.utilisee };
}

function pressionMemoire(sh: FortiShell, socle: SocleMemoire, part: number): void {
  const cible = Math.round(socle.total * part) - socle.utilisee;
  reserverJournal(sh, Math.max(98304, cible * 1024));
}

function seuils(sh: FortiShell, extreme: number, rouge: number, vert: number): string {
  return run(sh, 'config system global',
    `set memory-use-threshold-extreme ${extreme}`,
    `set memory-use-threshold-red ${rouge}`,
    `set memory-use-threshold-green ${vert}`, 'end');
}

function conserveAllume(sh: FortiShell): boolean {
  return /memory conserve mode:\s+on$/m
    .test(run(sh, 'diagnose hardware sysinfo conserve'));
}

describe('FortiOS — la memoire est une mesure', () => {
  beforeEach(() => { Logger.reset(); });

  it('un pare-feu demarre n a pas zero octet de memoire utilisee', () => {
    const { sh } = pareFeu();
    expect(memoire(sh).utilisee).toBeGreaterThan(0);
  });

  it('les parts de la ligne Memory decrivent la meme machine', () => {
    const { sh } = pareFeu();
    const m = memoire(sh);
    expect(m.utilisee + m.libre + m.liberable).toBe(m.total);
    expect(m.pourcentUtilise).toBeCloseTo((m.utilisee / m.total) * 100, 1);
  });

  it('reserver un tampon de journaux fait MONTER la memoire utilisee', () => {
    const { sh } = pareFeu();
    const avant = memoire(sh).utilisee;
    reserverJournal(sh, 64 * 1024 * 1024);
    expect(memoire(sh).utilisee).toBeGreaterThan(avant + 60_000);
  });

  it('rendre le tampon la fait REDESCENDRE', () => {
    const { sh } = pareFeu();
    reserverJournal(sh, 64 * 1024 * 1024);
    const charge = memoire(sh).utilisee;
    reserverJournal(sh, 98304);
    expect(memoire(sh).utilisee).toBeLessThan(charge);
  });

  it('remplir un tampon deja RESERVE ne change rien', () => {
    const { fw, sh } = pareFeu();
    reserverJournal(sh, 4 * 1024 * 1024);
    const avant = memoire(sh);

    for (let i = 0; i < 400; i++) {
      fw.getLogStore().append({
        at: horloge, type: 'event', subtype: 'system', level: 'information',
        id: '0100032001', fields: { msg: `essai numero ${i}`, action: 'login' },
      });
    }

    const apres = memoire(sh);
    expect(apres.utilisee).toBe(avant.utilisee);
    expect(apres.liberable).toBe(avant.liberable);
  });

  it('declarer des objets pese sur la memoire', () => {
    const { sh } = pareFeu();
    const avant = memoire(sh).utilisee;

    run(sh, 'config firewall address');
    for (let i = 0; i < 200; i++) {
      run(sh, `edit "hote-${i}"`, `set subnet 10.${i}.0.0 255.255.0.0`, 'next');
    }
    run(sh, 'end');

    expect(memoire(sh).utilisee).toBeGreaterThan(avant);
  });

  it('les sessions ouvertes par du vrai trafic pesent', async () => {
    const { fw, sh, client } = await laboratoire();
    const avant = memoire(sh).utilisee;

    await runOn(client, [`ping -c 1 ${SERVEUR}`]);
    expect(fw.getSessionTable().count()).toBeGreaterThan(0);
    expect(memoire(sh).utilisee).toBeGreaterThan(avant);
  });

  it('la RAM du chassis est declaree une seule fois', () => {
    const { sh } = pareFeu();
    const megaoctets = nombre(run(sh, 'get system status'), /(\d+) MB RAM/);
    expect(Math.round(memoire(sh).total / 1024)).toBe(megaoctets);
  });
});

describe('FortiOS — le CPU est une mesure', () => {
  beforeEach(() => { Logger.reset(); });

  it('un pare-feu au repos annonce cent pour cent d inactivite', () => {
    const { sh } = pareFeu();
    avance(10_000);
    expect(inactivite(sh)).toBe(100);
  });

  it('il y a une ligne d etat par CPU declare', () => {
    const { sh } = pareFeu();
    const vue = run(sh, 'get system performance status');
    const cpus = nombre(run(sh, 'get system status'), /VM Resources: (\d+) CPU/);
    for (let i = 0; i < cpus; i++) expect(vue).toContain(`CPU${i} states:`);
    expect(vue).not.toContain(`CPU${cpus} states:`);
  });

  it('le trafic qui traverse est COMPTE, paquet par paquet', async () => {
    const { fw, client } = await laboratoire();
    const avant = fw.getSystemLoad().packetsProcessed();

    await runOn(client, [`ping -c 4 ${SERVEUR}`]);

    expect(fw.getSystemLoad().packetsProcessed()).toBeGreaterThanOrEqual(avant + 8);
  });

  it('la fenetre glissante oublie le trafic ancien', async () => {
    const { fw, client } = await laboratoire();
    await runOn(client, [`ping -c 4 ${SERVEUR}`]);
    expect(fw.getSystemLoad().packetRate()).toBeGreaterThan(0);

    avance(120_000);
    expect(fw.getSystemLoad().packetRate()).toBe(0);
  });

  it('un debit qui atteint la capacite du chassis remplit le CPU', () => {
    const capacite = 100;
    const charge = new SystemLoad({
      now: () => horloge, cpuCount: 1, memoryKib: 1024,
      packetsPerSecondPerCpu: capacite,
    });

    for (let i = 0; i < capacite * 60; i++) charge.recordPacket('kernel');
    avance(60_000);

    const etats = charge.cpuStates();
    expect(etats.idle).toBe(0);
    expect(etats.system).toBe(100);
    expect(etats.user).toBe(0);
    expect(etats.nice).toBe(0);
    expect(etats.iowait).toBe(0);
  });

  it('le travail d inspection est du temps UTILISATEUR, le reste du systeme', () => {
    const charge = new SystemLoad({
      now: () => horloge, cpuCount: 1, memoryKib: 1024,
      packetsPerSecondPerCpu: 100,
    });

    for (let i = 0; i < 40 * 60; i++) charge.recordPacket('kernel');
    for (let i = 0; i < 20 * 60; i++) charge.recordPacket('inspection');
    avance(60_000);

    const etats = charge.cpuStates();
    expect(etats.system).toBe(40);
    expect(etats.user).toBe(20);
    expect(etats.idle).toBe(40);
  });

  it('diagnose sys top rend un pourcentage par processus, pas 0.0 en dur', async () => {
    const { fw, sh, client } = await laboratoire();
    await runOn(client, [`ping -c 4 ${SERVEUR}`]);

    const lignes = run(sh, 'diagnose sys top').split('\n')
      .filter(ligne => /^\s+\w+\s+\d+\s/.test(ligne));
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.every(ligne => /0\.0\s+0\.0\s*$/.test(ligne))).toBe(false);
    expect(fw.getSystemLoad().packetsProcessed()).toBeGreaterThan(0);
  });
});

describe('FortiOS — le mode conserve engage', () => {
  beforeEach(() => { Logger.reset(); });

  it('les seuils se reglent et la vue rend le seuil REGLE', () => {
    const { sh } = pareFeu();
    seuils(sh, 90, 85, 80);

    const vue = run(sh, 'diagnose hardware sysinfo conserve');
    expect(vue).toMatch(/threshold extreme:\s+\d+ MB\s+90% of total RAM/);
    expect(vue).toMatch(/threshold red:\s+\d+ MB\s+85% of total RAM/);
    expect(vue).toMatch(/threshold green:\s+\d+ MB\s+80% of total RAM/);
  });

  it('les seuils survivent a la relecture de la configuration', () => {
    const { sh } = pareFeu();
    seuils(sh, 90, 85, 80);
    expect(run(sh, 'show system global')).toContain('set memory-use-threshold-red 85');
  });

  it('un seuil hors bornes est REFUSE', () => {
    const { sh } = pareFeu();
    run(sh, 'config system global');
    const refus = run(sh, 'set memory-use-threshold-red 5');
    run(sh, 'end');
    expect(refus).not.toBe('');
    expect(run(sh, 'show system global')).not.toContain('memory-use-threshold-red 5');
  });

  it('le mode conserve est ARRETE sur un pare-feu au repos', () => {
    const { sh } = pareFeu();
    expect(run(sh, 'diagnose hardware sysinfo conserve'))
      .toMatch(/memory conserve mode:\s+off$/m);
  });

  it('franchir le seuil rouge ALLUME le mode conserve', () => {
    const { sh } = pareFeu();
    const socle = socleMemoire(sh);
    seuils(sh, 95, 80, 70);

    pressionMemoire(sh, socle, 0.85);
    expect(conserveAllume(sh)).toBe(true);
  });

  it('redescendre sous le ROUGE ne suffit pas — il faut le seuil VERT', () => {
    const { sh } = pareFeu();
    const socle = socleMemoire(sh);
    seuils(sh, 95, 80, 70);

    pressionMemoire(sh, socle, 0.85);
    expect(conserveAllume(sh)).toBe(true);

    pressionMemoire(sh, socle, 0.75);
    expect(conserveAllume(sh)).toBe(true);

    pressionMemoire(sh, socle, 0.60);
    expect(conserveAllume(sh)).toBe(false);
  });

  it('l entree en mode conserve est JOURNALISEE', () => {
    const { fw, sh } = pareFeu();
    const socle = socleMemoire(sh);
    seuils(sh, 95, 80, 70);
    pressionMemoire(sh, socle, 0.85);

    const journal = fw.getLogStore().select({ type: 'event' });
    expect(journal.some(record =>
      (record.fields.get('msg') ?? '').toLowerCase().includes('conserve'))).toBe(true);
  });

  it('en mode conserve extreme une NOUVELLE session est refusee', async () => {
    const { fw, sh, client } = await laboratoire();
    const socle = socleMemoire(sh);
    seuils(sh, 80, 78, 70);
    pressionMemoire(sh, socle, 0.85);

    const avant = fw.getSessionTable().count();
    await runOn(client, [`ping -c 2 ${SERVEUR}`]);
    expect(fw.getSessionTable().count()).toBe(avant);
  });

  it('av-failopen decide du sort de l inspection MANDATAIRE', () => {
    const { fw, sh } = pareFeu();
    const socle = socleMemoire(sh);
    const charge = fw.getSystemLoad();
    seuils(sh, 95, 80, 70);
    expect(charge.proxyInspectionPosture()).toBe('normal');

    pressionMemoire(sh, socle, 0.85);
    expect(charge.proxyInspectionPosture()).toBe('bypass');

    run(sh, 'config system global', 'set av-failopen off', 'end');
    expect(charge.proxyInspectionPosture()).toBe('block');
  });

  it('one-shot reste COLLE apres la sortie du mode conserve', () => {
    const { fw, sh } = pareFeu();
    const socle = socleMemoire(sh);
    const charge = fw.getSystemLoad();
    seuils(sh, 95, 80, 70);
    run(sh, 'config system global', 'set av-failopen one-shot', 'end');

    pressionMemoire(sh, socle, 0.85);
    expect(charge.proxyInspectionPosture()).toBe('bypass');

    pressionMemoire(sh, socle, 0.20);
    expect(conserveAllume(sh)).toBe(false);
    expect(charge.proxyInspectionPosture()).toBe('bypass');

    run(sh, 'config system global', 'set av-failopen pass', 'end');
    expect(charge.proxyInspectionPosture()).toBe('normal');
  });

  it('l inspection de FLUX echoue FERMEE par defaut, l inverse du mandataire', () => {
    const { fw, sh } = pareFeu();
    const socle = socleMemoire(sh);
    const charge = fw.getSystemLoad();
    seuils(sh, 95, 80, 70);
    pressionMemoire(sh, socle, 0.85);

    expect(charge.flowInspectionPosture()).toBe('block');
    expect(charge.proxyInspectionPosture()).toBe('bypass');

    run(sh, 'config ips global', 'set fail-open enable', 'end');
    expect(charge.flowInspectionPosture()).toBe('bypass');
    expect(run(sh, 'show ips global')).toContain('set fail-open enable');
  });

  it('une session DEJA etablie continue de passer en mode conserve', async () => {
    const { fw, sh, client, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl start nginx']);

    const socket = await client.tcpConnect(SERVEUR, 80);
    expect(socket).not.toBeNull();
    const ouvertes = fw.getSessionTable().count();
    expect(ouvertes).toBeGreaterThan(0);

    seuils(sh, 80, 78, 70);
    pressionMemoire(sh, socleMemoire(sh), 0.85);
    expect(fw.getSystemLoad().refusesNewSessions()).toBe(true);

    socket?.write('GET / HTTP/1.0\r\n\r\n');
    expect(fw.getSessionTable().count()).toBe(ouvertes);
    expect(fw.recentTraces().find(trace =>
      trace.verdict?.reason === 'memory-conserve-extreme')).toBeUndefined();
  });
});
