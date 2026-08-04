/**
 * Sondes — les manques de l'audit 13.
 *
 * **`archive` : un moteur auquel il manquait DEUX portes.**
 * `ArchiveService.capture()` était écrit et appelé de nulle part, si
 * bien qu'aucune révision ne pouvait exister. Conséquences mesurées
 * avant correction : `show archive` rendait « No archives configured »
 * alors que la running-config de la MÊME machine affichait le bloc
 * `archive` avec son chemin — deux vues qui ne peuvent pas avoir raison
 * ensemble ; `archive config`, la commande qui archive manuellement,
 * n'existait pas ; et `write-memory`, dont le sens EST « archive à
 * chaque sauvegarde », était mémorisé sans que rien ne le lise.
 *
 * Second défaut dans la branche opposée : « No backups exist on archive
 * path » était empilé sans condition, y compris juste avant d'énumérer
 * les sauvegardes. La sortie s'annonçait vide puis se remplissait.
 *
 * **Sur le switch, la famille entière était refusée.** Elle est
 * construite par le même module que celle du routeur
 * (`CiscoArchiveCommands`), pas recopiée : deux plateformes qui
 * archiveraient différemment seraient un défaut, pas une
 * fonctionnalité. C'est ce que le dernier scénario vérifie.
 *
 * **`rate-limit` : le choix est motivé, pas préféré.** La commande
 * était acceptée, absente de la running-config, et sans vue. Deux
 * issues possibles — refuser, ou stocker et afficher. Mesuré avant de
 * trancher : la MQC moderne (`class-map`/`policy-map`/`police`) est
 * stockée, rendue en running-config ET affichée par `show policy-map`,
 * sans qu'aucun octet ne soit jamais jeté. La QoS de ce simulateur est
 * donc fidèle au niveau configuration et ne police rien. Refuser le CAR
 * historique tout en acceptant son équivalent moderne aurait rendu la
 * plateforme incohérente avec elle-même.
 *
 * Les deux fonctionnalités sont RÉELLES, pas déclaratives, et c'est ce
 * que les deux derniers blocs vérifient : une archive est un fichier que
 * `dir flash:` voit et que `more` relit, effacé pour de bon par
 * `maximum` ; une politique CAR jette réellement des paquets sur le
 * chemin de données, et ses compteurs sont des mesures.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

type Dev = { executeCommand(c: string): Promise<string> };

async function routeur(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  return r;
}

async function commutateur(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
  await sw.executeCommand('enable');
  return sw;
}

/** Configure un archivage complet et rend l'appareil. */
async function configurerArchive(d: Dev): Promise<void> {
  await d.executeCommand('configure terminal');
  expect(await d.executeCommand('archive')).toBe('');
  expect(await d.executeCommand('path flash:cfg')).toBe('');
  expect(await d.executeCommand('maximum 5')).toBe('');
  expect(await d.executeCommand('write-memory')).toBe('');
  await d.executeCommand('end');
}

function nbRevisions(sortie: string): number {
  return sortie.split('\n').filter((l) => /^ {2}\d+: /.test(l)).length;
}

describe.each([
  ['routeur', routeur],
  ['switch', commutateur],
] as [string, () => Promise<Dev>][])('archive — %s', (_nom, fabrique) => {
  it('sans rien de configuré, la vue le dit', async () => {
    const d = await fabrique();
    expect(await d.executeCommand('show archive'))
      .toBe('No archives configured / no revisions captured.');
  });

  it('archiver sans chemin est refusé', async () => {
    const d = await fabrique();
    expect(await d.executeCommand('archive config')).toBe('% Archive path not configured');
  });

  it('configuré sans révision : la vue ne dit plus « aucun archivage »', async () => {
    const d = await fabrique();
    await configurerArchive(d);
    const out = await d.executeCommand('show archive');
    // Le défaut d'origine : cette ligne contredisait la running-config.
    expect(out).not.toContain('No archives configured');
    expect(out).toContain('Archive path: flash:cfg');
    expect(out).toContain('The maximum archive configurations allowed is 5.');
    expect(out).toContain('No backups exist on archive path');
  });

  it('la configuration figure dans la running-config', async () => {
    const d = await fabrique();
    await configurerArchive(d);
    const rc = (await d.executeCommand('show running-config')).split('\n').map((x) => x.trimEnd());
    expect(rc).toContain('archive');
    expect(rc).toContain(' path flash:cfg');
    expect(rc).toContain(' maximum 5');
    expect(rc).toContain(' write-memory');
  });

  it('`archive config` capture vraiment une révision', async () => {
    const d = await fabrique();
    await configurerArchive(d);
    expect(await d.executeCommand('archive config')).toBe('Writing flash:cfg-1');
    const out = await d.executeCommand('show archive');
    expect(nbRevisions(out)).toBe(1);
    expect(out).toContain('flash:cfg-1');
    expect(out).toContain('src=manual');
    // Une sauvegarde énumérée interdit d'annoncer qu'il n'y en a pas.
    expect(out).not.toContain('No backups exist');
    // La taille est celle de la configuration réellement archivée, pas 0.
    expect(out).toMatch(/, [1-9]\d*B, /);
  });

  it('`write memory` archive quand `write-memory` est posé', async () => {
    const d = await fabrique();
    await configurerArchive(d);
    await d.executeCommand('write memory');
    const out = await d.executeCommand('show archive');
    expect(nbRevisions(out)).toBe(1);
    expect(out).toContain('src=auto-write-memory');
  });

  it('sans `write-memory`, une sauvegarde n\'archive rien', async () => {
    const d = await fabrique();
    await d.executeCommand('configure terminal');
    await d.executeCommand('archive');
    await d.executeCommand('path flash:cfg');
    await d.executeCommand('end');
    await d.executeCommand('write memory');
    // C'est ce mot-clé, et lui seul, qui lie sauvegarde et archivage.
    expect(nbRevisions(await d.executeCommand('show archive'))).toBe(0);
  });

  it('`maximum` borne vraiment le nombre de révisions gardées', async () => {
    const d = await fabrique();
    await d.executeCommand('configure terminal');
    await d.executeCommand('archive');
    await d.executeCommand('path flash:cfg');
    await d.executeCommand('maximum 2');
    await d.executeCommand('end');
    for (let i = 0; i < 4; i++) await d.executeCommand('archive config');
    const out = await d.executeCommand('show archive');
    expect(nbRevisions(out)).toBe(2);
    // Ce sont les plus RÉCENTES qui restent.
    expect(out).toContain('flash:cfg-4');
    expect(out).not.toContain('flash:cfg-1');
  });

  it('l\'archive est un VRAI fichier du flash', async () => {
    const d = await fabrique();
    await configurerArchive(d);
    await d.executeCommand('configure terminal');
    await d.executeCommand('hostname RARCH');
    await d.executeCommand('end');
    await d.executeCommand('archive config');
    // Une archive qui n'écrit rien n'archive rien : `dir` doit la voir…
    expect(await d.executeCommand('dir flash:')).toContain('cfg-1');
    // …et son contenu doit être la configuration, pas un nom de fichier.
    expect(await d.executeCommand('more flash:cfg-1')).toContain('hostname RARCH');
  });

  it('`maximum` EFFACE le fichier le plus ancien, il ne l\'oublie pas', async () => {
    const d = await fabrique();
    await d.executeCommand('configure terminal');
    await d.executeCommand('archive');
    await d.executeCommand('path flash:cfg');
    await d.executeCommand('maximum 2');
    await d.executeCommand('end');
    for (let i = 0; i < 3; i++) await d.executeCommand('archive config');
    // Sans la suppression, la flash se remplirait de fichiers que plus
    // rien ne nomme — une fuite, pas une rotation.
    expect(await d.executeCommand('more flash:cfg-1')).toContain('No such file or directory');
    expect(await d.executeCommand('dir flash:')).not.toContain('cfg-1');
    expect(await d.executeCommand('dir flash:')).toContain('cfg-3');
  });

  it('la différence entre archives demande deux archives', async () => {
    const d = await fabrique();
    await configurerArchive(d);
    expect(await d.executeCommand('show archive config differences'))
      .toBe('No archive differences available.');
    await d.executeCommand('archive config');
    await d.executeCommand('archive config');
    expect(await d.executeCommand('show archive config differences'))
      .toContain('Differences between latest two archives');
  });
});

describe('archive — les deux plateformes répondent la MÊME chose', () => {
  it('même sortie de `show archive` pour la même configuration', async () => {
    const r = await routeur();
    const sw = await commutateur();
    for (const d of [r, sw]) {
      await configurerArchive(d);
      await d.executeCommand('archive config');
    }
    const norm = (s: string) => s.replace(/\(\d{4}-[^)]*\)/, '(HORODATAGE)');
    // Un routeur et un switch qui archiveraient différemment seraient un
    // défaut : c'est le même service, construit par le même module.
    expect(norm(await sw.executeCommand('show archive')))
      .toBe(norm(await r.executeCommand('show archive')));
  });
});

describe('rate-limit — la politique CAR police vraiment', () => {
  const REGLE = 'rate-limit output 8000 100 200 conform-action transmit exceed-action drop';

  async function lab(regle: string | null) {
    const r = new CiscoRouter('R1');
    const a = new LinuxPC('linux-pc', 'pcA', 0, 0); a.powerOn();
    const b = new LinuxPC('linux-pc', 'pcB', 0, 0); b.powerOn();
    new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, a.getPort('eth0')!);
    new Cable('c2').connect(r.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const [i, ip] of [['GigabitEthernet0/0', '10.1.1.1'], ['GigabitEthernet0/1', '10.2.2.1']]) {
      await r.executeCommand(`interface ${i}`);
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
    }
    if (regle) {
      await r.executeCommand('interface GigabitEthernet0/1');
      expect(await r.executeCommand(regle)).toBe('');
    }
    await r.executeCommand('end');
    await a.executeCommand('sudo ip addr add 10.1.1.10/24 dev eth0');
    await a.executeCommand('sudo ip route add default via 10.1.1.1');
    await b.executeCommand('sudo ip addr add 10.2.2.10/24 dev eth0');
    await b.executeCommand('sudo ip route add default via 10.2.2.1');
    return { r, a };
  }

  it('sans règle, le trafic passe', async () => {
    const { a } = await lab(null);
    expect(await a.executeCommand('ping -c 2 -W 1 10.2.2.10')).toContain(', 0% packet loss');
  }, 30000);

  it('une rafale plus petite qu\'un paquet jette TOUT le trafic', async () => {
    // 84 octets par ping, rafale de 50 : aucun paquet ne tient dans le
    // seau, donc chacun est en excès et l'action `drop` s'applique.
    const { r, a } = await lab('rate-limit output 8000 50 100 conform-action transmit exceed-action drop');
    expect(await a.executeCommand('ping -c 3 -W 1 10.2.2.10')).toContain(', 100% packet loss');
    const vue = await r.executeCommand('show interfaces GigabitEthernet0/1 rate-limit');
    // Les compteurs sont une MESURE : trois paquets vus, trois jetés.
    expect(vue).toContain('exceeded 3 packets, 252 bytes; action: drop');
    expect(vue).toContain('conformed 0 packets, 0 bytes');
  }, 30000);

  it('une rafale suffisante laisse passer, et le compte le dit', async () => {
    const { r, a } = await lab(REGLE);
    expect(await a.executeCommand('ping -c 3 -W 1 10.2.2.10')).toContain(', 0% packet loss');
    const vue = await r.executeCommand('show interfaces GigabitEthernet0/1 rate-limit');
    expect(vue).toContain('conformed 3 packets, 252 bytes; action: transmit');
    expect(vue).toContain('exceeded 0 packets');
  }, 30000);

  it('`exceed-action transmit` compte l\'excès sans jeter', async () => {
    // Ce que CAR permet et qui distingue mesurer de sanctionner.
    const { r, a } = await lab('rate-limit output 8000 50 100 conform-action transmit exceed-action transmit');
    expect(await a.executeCommand('ping -c 2 -W 1 10.2.2.10')).toContain(', 0% packet loss');
    expect(await r.executeCommand('show interfaces GigabitEthernet0/1 rate-limit'))
      .toContain('exceeded 2 packets, 168 bytes; action: transmit');
  }, 30000);

  it('la règle revient dans la running-config', async () => {
    const { r } = await lab(REGLE);
    expect((await r.executeCommand('show running-config')).split('\n').map((x) => x.trim()))
      .toContain(REGLE);
  }, 30000);

  it('`show interfaces <if> rate-limit` rend les paramètres saisis', async () => {
    const { r } = await lab(REGLE);
    const out = await r.executeCommand('show interfaces GigabitEthernet0/1 rate-limit');
    expect(out).toContain('params:  8000 bps, 100 limit, 200 extended limit');
  }, 30000);

  it('une règle mal formée est refusée, pas stockée', async () => {
    const { r } = await lab(null);
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    // Un sens invalide, une rafale max sous la normale, un débit nul :
    // stocker l'une d'elles donnerait une politique qui ne police rien.
    expect(await r.executeCommand('rate-limit sideways 8000 100 200 conform-action transmit exceed-action drop'))
      .toContain('Invalid input');
    expect(await r.executeCommand('rate-limit output 8000 200 100 conform-action transmit exceed-action drop'))
      .toContain('Invalid input');
    expect(await r.executeCommand('rate-limit output 0 100 200 conform-action transmit exceed-action drop'))
      .toContain('Invalid input');
    await r.executeCommand('end');
    expect(await r.executeCommand('show interfaces GigabitEthernet0/0 rate-limit'))
      .toBe('GigabitEthernet0/0');
  }, 30000);

  it('`no rate-limit` retire la politique et le trafic repasse', async () => {
    const { r, a } = await lab('rate-limit output 8000 50 100 conform-action transmit exceed-action drop');
    expect(await a.executeCommand('ping -c 2 -W 1 10.2.2.10')).toContain(', 100% packet loss');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/1');
    await r.executeCommand('no rate-limit');
    await r.executeCommand('end');
    expect(await a.executeCommand('ping -c 2 -W 1 10.2.2.10')).toContain(', 0% packet loss');
  }, 30000);

  it('une interface inexistante est refusée', async () => {
    const { r } = await lab(null);
    expect(await r.executeCommand('show interfaces GigabitEthernet9/9 rate-limit'))
      .toContain('Invalid input');
  }, 30000);

  it('les autres sous-formes de `show interfaces` marchent toujours', async () => {
    const { r } = await lab(REGLE);
    expect(await r.executeCommand('show interfaces GigabitEthernet0/0 accounting')).toContain('Pkts In');
    expect(await r.executeCommand('show interfaces GigabitEthernet0/0 stats')).toContain('Switching path');
    expect(await r.executeCommand('show interfaces GigabitEthernet0/0 switchport')).toContain('Switchport:');
  }, 30000);
});

describe('show running-config all', () => {
  it('rend la configuration, pas seulement sa bannière', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    await r.executeCommand('hostname RTEST');
    await r.executeCommand('end');
    const out = await r.executeCommand('show running-config all');
    // `_getRunningConfigText` n'est défini sur aucun appareil : la vue
    // ne rendait que « Building configuration... » pendant que
    // `show running-config` rendait ses lignes sur la même machine.
    expect(out).toContain('Building configuration...');
    expect(out).toContain('hostname RTEST');
    expect(out.split('\n').length).toBeGreaterThan(5);
  });
});
