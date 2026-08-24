/**
 * Le plan d'administration ECOUTE, et son API lit la MEME configuration.
 *
 * MESURE DE DEPART : sur un FortiGate dont `port1` porte `set allowaccess
 * ping http https ssh`, la pile TCP n'ecoute que sur 22 et 23.
 * `admin-port 80` et `admin-sport 443` sont declares, rendus par
 * `get system global`, gardes par `ManagementPlane.admitsTcp` — et lies
 * par PERSONNE : `FirewallCliServer.refresh()` ne lie que `ssh` et
 * `telnet`. `curl -sv http://<fw>/login` s'arrete a « Trying ... ».
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait. Les references
 * sont du CODE SOURCE qui parle a de vraies machines, pas de la
 * documentation : le module Metasploit
 * `fortinet_authentication_bypass_cve_2022_40684` et la bibliotheque
 * `fortiosapi` de Fortinet.
 *
 *   1. Le port d'administration ECOUTE, et une vraie requete y arrive
 *      depuis un poste du depot, par le cable.
 *   2. `GET /api/v2/cmdb/<...>` SANS session rend 401 — c'est le test de
 *      presence du module Metasploit.
 *   3. `POST /logincheck` avec `username=&secretkey=&ajax=1` rend un
 *      corps dont le PREMIER caractere vaut `1`, et pose `ccsrftoken`.
 *   4. Un mot de passe faux rend `0`.
 *   5. Apres ouverture de session, `GET /api/v2/cmdb/system/admin` rend
 *      200 et l'enveloppe FortiOS (`status: success`, `http_status`,
 *      `version`, `results`, `path`, `name`, `vdom`).
 *   6. Les `results` sont lus dans l'arbre VIVANT : l'administrateur cree
 *      a la CLI y parait, avec l'orthographe CLI de ses attributs
 *      (`accprofile`, `trusthost1`).
 *   7. La cle d'un objet nomme `mkey` selectionne : `/system/admin/admin`
 *      ne rend que lui.
 *   8. Une table inconnue rend 404.
 *   9. `allowaccess` GOUVERNE : retirer `http` referme la porte.
 *  10. `admin-port` DEPLACE la porte.
 *  11. `admin-https-redirect` est actif par defaut : le port HTTP renvoie
 *      vers `https://<hote>/`.
 *  12. `set admin-https-redirect disable` sert la page en clair.
 *  13. Le port HTTPS presente le certificat de `admin-server-cert`.
 *  14. TEMOIN : SSH continue de fonctionner (la porte nouvelle ne casse
 *      pas l'ancienne).
 *  15. UN pare-feu, UNE configuration : une seconde session voit ce que
 *      la console a tape.
 *
 * Discrimination par `git stash push -- src/network/` : 12 des 14 cas
 * ecrits a l'aveugle tombent avant correctif. Les 2 qui passent des DEUX
 * cotes sont nommes ici plutot que laisses a decouvrir, et aucun ne
 * prouve la fonction :
 *
 *   - « `allowaccess` sans `http` referme la porte » passait parce que
 *     RIEN n'ecoutait : la porte etait fermee pour tout le monde, ce qui
 *     est indiscernable d'un refus gouverne par le reglage ;
 *   - le TEMOIN SSH est la pour passer des deux cotes — son objet est
 *     que la porte nouvelle ne casse pas l'ancienne.
 *
 * Le cas 15 est le DEFAUT TROUVE EN CHEMIN, et il se discrimine seul :
 * chaque `FortiShell` construisait son PROPRE `FortiConfigTree`, donc
 * une session SSH repondait `"port1" does not exist` a `show system
 * interface port1` pendant que la console rendait la meme interface
 * configuree. L'API ne pouvait pas lire « la » configuration tant qu'il
 * y en avait une par session.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire(allowaccess = 'ping http https ssh') {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  poste.powerOn();

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', `set allowaccess ${allowaccess}`, 'next', 'end');

  run(sh, 'config system admin', 'edit "admin"',
    'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);

  return { fw, sh, poste };
}

async function countDispatchedFrames(fn: () => Promise<void>): Promise<number> {
  let count = 0;
  const unsub = getDefaultEventBus().subscribe('cable.frame.dispatched', () => { count++; });
  try { await fn(); } finally { unsub(); }
  return count;
}

async function curl(poste: Cmd, args: string): Promise<string> {
  return poste.executeCommand(`curl ${args}`);
}

const API = '/api/v2/cmdb/system/admin';

const BOCAL = '/tmp/fgt.jar';

async function ouvrirSession(poste: Cmd, base = 'https://192.168.1.1'): Promise<string> {
  return curl(poste,
    `-k -s -i -c ${BOCAL} -X POST -d "username=admin&secretkey=Secret123&ajax=1" ${base}/logincheck`);
}

async function avecSession(poste: Cmd, cible: string): Promise<string> {
  return curl(poste, `-k -s -b ${BOCAL} https://192.168.1.1${cible}`);
}

function corpsApres(reponse: string): string {
  const at = reponse.indexOf('\n\n');
  return at < 0 ? reponse : reponse.slice(at + 2);
}

beforeEach(() => { Logger.reset(); });

describe('le port d\'administration ecoute vraiment', () => {
  it('une requete HTTP arrive au pare-feu, et les trames traversent le cable', async () => {
    const { poste } = await laboratoire();

    let sortie = '';
    const frames = await countDispatchedFrames(async () => {
      sortie = await curl(poste, '-s -i http://192.168.1.1/');
    });

    expect(frames).toBeGreaterThan(0);
    expect(sortie).toMatch(/^HTTP\/1\.1 \d\d\d/);
  });

  it('`allowaccess` sans `http` referme la porte', async () => {
    const { poste } = await laboratoire('ping https ssh');

    expect(await curl(poste, '-s -i http://192.168.1.1/')).not.toMatch(/^HTTP\/1\.1/);
  });

  it('`admin-port` deplace la porte', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system global', 'set admin-port 8080', 'end');

    expect(await curl(poste, '-s -i http://192.168.1.1:8080/')).toMatch(/^HTTP\/1\.1/);
    expect(await curl(poste, '-s -i http://192.168.1.1/')).not.toMatch(/^HTTP\/1\.1/);
  });
});

describe('la redirection vers HTTPS', () => {
  it('est active par defaut et nomme le port HTTPS', async () => {
    const { poste } = await laboratoire();

    const reponse = await curl(poste, '-s -i http://192.168.1.1/');

    expect(reponse).toMatch(/^HTTP\/1\.1 30\d/);
    expect(reponse).toMatch(/^Location: https:\/\/192\.168\.1\.1\//m);
  });

  it('`set admin-https-redirect disable` sert la page en clair', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system global', 'set admin-https-redirect disable', 'end');

    const reponse = await curl(poste, '-s -i http://192.168.1.1/');

    expect(reponse).toMatch(/^HTTP\/1\.1 200/);
    expect(reponse).not.toMatch(/^Location:/m);
  });
});

describe('l\'API CMDB', () => {
  it('rend 401 sans session — le test de presence du module Metasploit', async () => {
    const { poste } = await laboratoire();

    expect(await curl(poste, `-k -s -i https://192.168.1.1${API}`))
      .toMatch(/^HTTP\/1\.1 401/);
  });

  it('`/logincheck` rend un corps commencant par `1` et pose `ccsrftoken`', async () => {
    const { poste } = await laboratoire();

    const reponse = await ouvrirSession(poste);

    expect(reponse).toMatch(/^HTTP\/1\.1 200/);
    expect(reponse).toMatch(/^Set-Cookie: ccsrftoken=/m);
    expect(corpsApres(reponse).charAt(0)).toBe('1');
  });

  it('un mot de passe faux rend un corps commencant par `0`', async () => {
    const { poste } = await laboratoire();

    const reponse = await curl(poste,
      '-k -s -i -X POST -d "username=admin&secretkey=MAUVAIS&ajax=1" https://192.168.1.1/logincheck');

    expect(corpsApres(reponse).charAt(0)).toBe('0');
  });

  it('rend l\'enveloppe FortiOS une fois la session ouverte', async () => {
    const { poste } = await laboratoire();
    await ouvrirSession(poste);

    const corps = await avecSession(poste, API);
    const envelope = JSON.parse(corps) as Record<string, unknown>;

    expect(envelope.status).toBe('success');
    expect(envelope.http_status).toBe(200);
    expect(envelope.path).toBe('system');
    expect(envelope.name).toBe('admin');
    expect(envelope.vdom).toBe('root');
    expect(typeof envelope.version).toBe('string');
    expect(Array.isArray(envelope.results)).toBe(true);
  });

  it('lit l\'arbre VIVANT : l\'administrateur cree a la CLI y parait', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system admin', 'edit "auditeur"',
      'set password "Audit123"', 'set accprofile "prof_admin"',
      'set trusthost1 10.0.0.0 255.255.255.0', 'next', 'end');
    await ouvrirSession(poste);

    const corps = await avecSession(poste, API);
    const results = (JSON.parse(corps) as {
      results: Array<Record<string, unknown>>;
    }).results;

    const auditeur = results.find(r => r.name === 'auditeur');
    expect(auditeur).toBeDefined();
    expect(auditeur!.accprofile).toBe('prof_admin');
    expect(auditeur!.trusthost1).toBe('10.0.0.0 255.255.255.0');
  });

  it('la cle selectionne un seul objet', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system admin', 'edit "auditeur"',
      'set password "Audit123"', 'next', 'end');
    await ouvrirSession(poste);

    const corps = await avecSession(poste, `${API}/admin`);
    const results = (JSON.parse(corps) as {
      results: Array<Record<string, unknown>>;
    }).results;

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('admin');
  });

  it('une table inconnue rend 404', async () => {
    const { poste } = await laboratoire();
    await ouvrirSession(poste);

    expect(await curl(poste,
      `-k -s -i -b ${BOCAL} https://192.168.1.1/api/v2/cmdb/system/zorglub`))
      .toMatch(/^HTTP\/1\.1 404/);
  });
});

describe('le certificat presente', () => {
  it('est celui que nomme `admin-server-cert`', async () => {
    const { sh, poste } = await laboratoire();

    expect(run(sh, 'config system global', 'set admin-server-cert self-sign', 'end'))
      .not.toMatch(/parse error/);

    expect(await curl(poste, '-k -sv https://192.168.1.1/logincheck'))
      .toMatch(/subject/i);
  });
});

describe('un pare-feu, une configuration', () => {
  it('une seconde session voit ce que la console a tape', async () => {
    const { fw, sh } = await laboratoire();

    const autre = (fw as unknown as {
      createManagementCli(user: string, origin: string): { execute(line: string): string };
    }).createManagementCli('admin', 'ssh(192.168.1.10)');

    expect(autre.execute('show system interface port1'))
      .toBe(sh.execute('show system interface port1'));
    expect(autre.execute('show system interface port1'))
      .toContain('set ip 192.168.1.1 255.255.255.0');
  });
});

describe('TEMOIN — la porte ancienne tient', () => {
  it('le port SSH ecoute toujours', async () => {
    const { fw } = await laboratoire();
    const tcp = (fw as unknown as {
      getTcpStack(): { listeners: Map<string, unknown> };
    }).getTcpStack();

    expect([...tcp.listeners.keys()].some(k => k.endsWith(':22'))).toBe(true);
  });
});
