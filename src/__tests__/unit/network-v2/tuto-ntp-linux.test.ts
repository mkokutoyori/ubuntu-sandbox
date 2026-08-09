/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — les labs NTP Linux du tutoriel
 * (§5, chrony), reproduits.
 *
 * Le point de depart etait le plus grave des quatre plateformes : le
 * paquet `chrony` etait declare installe par `apt-get`/`dpkg` et **rien
 * n'existait** — ni `chronyc`, ni `chronyd`, ni son unite, ni
 * `/etc/chrony/chrony.conf`. Sur cette meme machine, sans aucun demon de
 * temps :
 *
 *     $ timedatectl
 *     System clock synchronized: yes
 *                   NTP service: active
 *
 * Deux affirmations que rien ne soutenait. Et `timedatectl set-timezone
 * Africa/Douala` etait accepte sans rien changer.
 *
 * Le premier bloc verifie donc que la machine se SYNCHRONISE, avec un
 * vrai serveur au bout d'un vrai cable — le reste ne serait que du
 * texte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { parseChronyConf } from '@/network/devices/linux/time/ChronyConfig';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/** Le serveur NTP du tutoriel, en 192.168.100.5. */
async function serveur() {
  const r = new CiscoRouter(`SRV${++serie}`);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.100.5 255.255.255.0', 'no shutdown', 'exit',
    'ntp master 2', 'end']) await r.executeCommand(c);
  return r;
}

/** Un poste Linux cable au serveur. */
async function poste(srv: CiscoRouter, ip = '192.168.100.9') {
  const pc = new LinuxPC(`L${++serie}`);
  new Cable(`n${serie}`).connect(srv.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  await pc.executeCommand(`ip addr add ${ip}/24 dev eth0`);
  return pc;
}

/**
 * Ecrire `/etc/chrony/chrony.conf`. Le fichier appartient a root — comme
 * sur une vraie machine, et c'est pourquoi le tutoriel ecrit
 * `sudo nano` : sans `sudo`, l'ecriture est refusee, ce qu'un cas
 * ci-dessous verifie.
 */
async function ecrireConf(pc: LinuxPC, texte: string): Promise<string> {
  return pc.executeCommand(
    `printf '${texte.replace(/\n/g, '\\n')}' | sudo tee /etc/chrony/chrony.conf`);
}

const CONF_TUTO = [
  'server 192.168.100.5 iburst prefer',
  'server 192.168.100.6 iburst',
  'driftfile /var/lib/chrony/drift',
  'makestep 1.0 3',
  'allow 192.168.100.0/24',
  'logdir /var/log/chrony',
  'log measurements statistics tracking',
].join('\n');

const ligne = (s: string, debut: string) =>
  s.split('\n').find((l) => l.trim().startsWith(debut))?.trim() ?? '';

describe('§5.2 — le paquet existe vraiment', () => {
  it('`chronyc` et `chronyd` sont sur le disque', async () => {
    const pc = new LinuxPC(`P${++serie}`);
    expect(await pc.executeCommand('which chronyc')).toContain('/usr/bin/chronyc');
    expect(await pc.executeCommand('ls /usr/sbin/chronyd')).toContain('chronyd');
  });

  it('l\'unite existe, sous ses DEUX noms', async () => {
    // Debian la nomme `chrony`, RHEL `chronyd`, et le tutoriel montre
    // les deux : un lecteur qui suit la colonne RHEL ne doit pas tomber
    // sur un `Unit could not be found` qui ne lui apprend rien sur NTP.
    const pc = new LinuxPC(`P${++serie}`);
    for (const nom of ['chrony', 'chronyd']) {
      const out = await pc.executeCommand(`systemctl status ${nom}`);
      expect(out, nom).toContain('chrony.service');
      expect(out, nom).not.toContain('could not be found');
    }
  });

  it('le fichier de configuration que Debian livre est la', async () => {
    const pc = new LinuxPC(`P${++serie}`);
    const conf = await pc.executeCommand('cat /etc/chrony/chrony.conf');
    expect(conf).toContain('driftfile');
    expect(conf).toContain('makestep');
  });

  it('il appartient a root : le tutoriel a raison d\'ecrire `sudo`', async () => {
    const pc = new LinuxPC(`P${++serie}`);
    expect(await pc.executeCommand('echo x > /etc/chrony/chrony.conf'))
      .toContain('Permission denied');
  });
});

describe('§5.2 — le fichier de configuration est LU', () => {
  it('les directives du tutoriel sont toutes comprises', () => {
    const c = parseChronyConf(CONF_TUTO);
    expect(c.sources).toHaveLength(2);
    expect(c.sources[0]).toMatchObject({ hote: '192.168.100.5', iburst: true, prefer: true });
    expect(c.sources[1]).toMatchObject({ hote: '192.168.100.6', prefer: false });
    expect(c.makestep).toEqual({ seuilSec: 1, limite: 3 });
    expect(c.allow).toEqual(['192.168.100.0/24']);
    expect(c.driftfile).toBe('/var/lib/chrony/drift');
    expect(c.logs).toEqual(['measurements', 'statistics', 'tracking']);
    expect(c.inconnues).toEqual([]);
  });

  it('une directive inconnue est SIGNALEE, pas avalee en silence', () => {
    const c = parseChronyConf('server 10.0.0.1\nzzzz 42\n');
    expect(c.inconnues).toEqual([{ ligne: 2, texte: 'zzzz 42' }]);
  });

  it('une directive connue mais non appliquee est distinguee de l\'inconnue', () => {
    // Les deux familles ne se confondent pas : `refclock` existe chez
    // chronyd et ce simulateur n'a aucun materiel derriere.
    const c = parseChronyConf('refclock PPS /dev/pps0 lock NMEA\n');
    expect(c.acceptesSansEffet).toHaveLength(1);
    expect(c.inconnues).toEqual([]);
  });

  it('le fichier de Debian se lit sans une seule ligne inconnue', async () => {
    const pc = new LinuxPC(`P${++serie}`);
    const c = parseChronyConf(await pc.executeCommand('cat /etc/chrony/chrony.conf'));
    expect(c.inconnues).toEqual([]);
  });
});

describe('§5.3 — la machine se synchronise, et `chronyc` le montre', () => {
  async function labo() {
    const srv = await serveur();
    const pc = await poste(srv);
    await ecrireConf(pc, CONF_TUTO);
    await pc.executeCommand('sudo systemctl restart chrony');
    return { srv, pc };
  }

  it('`chronyc tracking` donne la source et la strate', async () => {
    const { pc } = await labo();
    const t = await pc.executeCommand('chronyc tracking');
    expect(ligne(t, 'Reference ID')).toContain('(192.168.100.5)');
    expect(ligne(t, 'Stratum')).toBe('Stratum         : 3');
    expect(t).toContain('Leap status     : Normal');
  });

  it('`chronyc sources` marque la source retenue `^*`', async () => {
    const { pc } = await labo();
    const s = await pc.executeCommand('chronyc sources');
    expect(s).toContain('MS Name/IP address');
    expect(ligne(s, '^*')).toContain('192.168.100.5');
    // La source injoignable est comptee sans etre retenue.
    expect(ligne(s, '^?')).toContain('192.168.100.6');
  });

  it('`Poll` est le LOGARITHME de l\'intervalle, pas l\'intervalle', async () => {
    // 64 s s'ecrit 6 : c'est la colonne que la legende du tutoriel prend
    // la peine d'expliquer, et l'ecrire en secondes la rendrait fausse.
    const { pc } = await labo();
    const l = ligne(await pc.executeCommand('chronyc sources'), '^*');
    expect(l.split(/\s+/)).toContain('6');
    expect(l).not.toContain('64');
  });

  it('`-v` ajoute la legende que le tutoriel montre', async () => {
    const { pc } = await labo();
    const v = await pc.executeCommand('chronyc sources -v');
    expect(v).toContain("Source mode  '^' = server");
    expect(v).toContain('Reachability register (octal)');
  });

  it('`chronyc sourcestats` et `activity` repondent', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('chronyc sourcestats'))
      .toContain('Name/IP Address            NP  NR  Span');
    expect(await pc.executeCommand('chronyc activity')).toContain('1 sources online');
  });

  it('`chronyc makestep` respecte le quota de la directive', async () => {
    // `makestep 1.0 3` autorise TROIS sauts : un quatrieme doit etre
    // refuse, sinon la directive ne veut rien dire.
    const { pc } = await labo();
    for (let i = 0; i < 3; i++) {
      expect(await pc.executeCommand('chronyc makestep'), `saut ${i}`).toBe('200 OK');
    }
    expect(await pc.executeCommand('chronyc makestep')).not.toBe('200 OK');
  });
});

describe('§5.3 — chronyc parle au DEMON', () => {
  it('sans chronyd, elle repond ce que repond la vraie', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    await pc.executeCommand('sudo systemctl stop chrony');
    for (const sous of ['tracking', 'sources', 'sourcestats', 'makestep']) {
      expect(await pc.executeCommand(`chronyc ${sous}`), sous)
        .toBe('506 Cannot talk to daemon');
    }
  });

  it('une sous-commande inconnue est refusee', async () => {
    const pc = new LinuxPC(`P${++serie}`);
    expect(await pc.executeCommand('chronyc zzz')).toContain('unknown command');
  });

  it('un fichier de configuration ABSENT empeche le demarrage', async () => {
    // Un fichier absent et un fichier vide sont deux pannes distinctes,
    // la meme distinction que `CriticalFiles.ts` tient pour sshd.
    const pc = new LinuxPC(`P${++serie}`);
    await pc.executeCommand('sudo rm /etc/chrony/chrony.conf');
    const out = await pc.executeCommand('sudo systemctl restart chrony');
    expect(out).toContain('Cannot open configuration file');
  });

  it('un fichier VIDE demarre, et simplement sans source', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    await ecrireConf(pc, '');
    expect(await pc.executeCommand('sudo systemctl restart chrony')).not.toContain('Cannot open');
    expect(await pc.executeCommand('chronyc sources')).toContain('0 Sources');
  });

  it('retirer une source du fichier puis recharger la retire vraiment', async () => {
    // Sans cela un rechargement ne serait qu'un ajout, et editer le
    // fichier pour ENLEVER un serveur n'aurait aucun effet.
    const srv = await serveur();
    const pc = await poste(srv);
    await ecrireConf(pc, CONF_TUTO);
    await pc.executeCommand('sudo systemctl restart chrony');
    expect(await pc.executeCommand('chronyc sources')).toContain('192.168.100.6');
    await ecrireConf(pc, 'server 192.168.100.5 iburst prefer');
    await pc.executeCommand('chronyc reload');
    const s = await pc.executeCommand('chronyc sources');
    expect(s).toContain('192.168.100.5');
    expect(s).not.toContain('192.168.100.6');
  });
});

describe('§5.3 — `timedatectl` dit ce qu\'il sait', () => {
  it('sans demon, il ne pretend plus etre synchronise', async () => {
    // Il affirmait `yes`/`active` sur une machine sans aucun demon.
    const pc = new LinuxPC(`P${++serie}`);
    await pc.executeCommand('sudo systemctl stop chrony');
    const t = await pc.executeCommand('timedatectl');
    expect(ligne(t, 'System clock synchronized')).toBe('System clock synchronized: no');
    expect(ligne(t, 'NTP service')).toBe('NTP service: inactive');
  });

  it('avec un demon mais sans source, le service est actif et l\'horloge non', async () => {
    // Les deux lignes disent des choses DIFFERENTES, et c'est exactement
    // le cas qu'un depannage cherche.
    const pc = new LinuxPC(`P${++serie}`);
    await ecrireConf(pc, '');
    await pc.executeCommand('sudo systemctl restart chrony');
    const t = await pc.executeCommand('timedatectl');
    expect(ligne(t, 'NTP service')).toBe('NTP service: active');
    expect(ligne(t, 'System clock synchronized')).toBe('System clock synchronized: no');
  });

  it('une fois synchronise, les deux disent oui', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    await ecrireConf(pc, CONF_TUTO);
    await pc.executeCommand('sudo systemctl restart chrony');
    const t = await pc.executeCommand('timedatectl');
    expect(ligne(t, 'System clock synchronized')).toBe('System clock synchronized: yes');
    expect(ligne(t, 'NTP service')).toBe('NTP service: active');
  });

  it('`set-ntp false` arrete le service, et la vue suit', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    await ecrireConf(pc, CONF_TUTO);
    await pc.executeCommand('sudo systemctl restart chrony');
    await pc.executeCommand('sudo timedatectl set-ntp false');
    expect(ligne(await pc.executeCommand('timedatectl'), 'NTP service'))
      .toBe('NTP service: inactive');
  });
});

describe('§5.3 — le fuseau horaire', () => {
  it('`set-timezone Africa/Douala` decale l\'heure pour de bon', async () => {
    // Il etait accepte et ne changeait rien : l'heure restait UTC et la
    // vue ecrivait `(UTC, +0000)` quel que soit le fuseau.
    const pc = new LinuxPC(`P${++serie}`);
    const avant = await pc.executeCommand('timedatectl');
    expect(ligne(avant, 'Time zone')).toContain('Etc/UTC (UTC, +0000)');
    await pc.executeCommand('sudo timedatectl set-timezone Africa/Douala');
    const apres = await pc.executeCommand('timedatectl');
    expect(ligne(apres, 'Time zone')).toBe('Time zone: Africa/Douala (WAT, +0100)');
    // `Local time: Sun 2026-08-09 21:03:15 WAT` — l'heure est le
    // quatrieme mot de la ligne une fois l'intitule retire.
    const h = (s: string) =>
      parseInt(ligne(s, 'Local time').split(/\s+/)[4].slice(0, 2), 10);
    expect((h(avant) + 1) % 24).toBe(h(apres));
  });

  it('les fichiers que systemd ecrit vraiment suivent', async () => {
    // Sans eux, `cat /etc/timezone` contredirait `timedatectl` sur la
    // meme machine.
    const pc = new LinuxPC(`P${++serie}`);
    await pc.executeCommand('sudo timedatectl set-timezone Africa/Douala');
    expect(await pc.executeCommand('cat /etc/timezone')).toContain('Africa/Douala');
    expect(await pc.executeCommand('ls /etc/localtime')).toContain('localtime');
  });

  it('`list-timezones` repond, et le tutoriel y trouve son fuseau', async () => {
    const pc = new LinuxPC(`P${++serie}`);
    const l = await pc.executeCommand('timedatectl list-timezones');
    expect(l.split('\n').length).toBeGreaterThan(20);
    expect(l).toContain('Africa/Douala');
    expect(await pc.executeCommand('timedatectl list-timezones | grep Africa'))
      .toContain('Africa/Lagos');
  });

  it('un fuseau qui n\'existe pas est refuse', async () => {
    const pc = new LinuxPC(`P${++serie}`);
    expect(await pc.executeCommand('sudo timedatectl set-timezone Mars/Olympus'))
      .toContain('Invalid time zone');
    expect(await pc.executeCommand('timedatectl')).toContain('Etc/UTC');
  });
});
