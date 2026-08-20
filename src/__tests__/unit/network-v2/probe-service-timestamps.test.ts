/**
 * Sonde — `service timestamps` sur IOS, de la grammaire jusqu'à la ligne
 * écrite dans le journal.
 *
 * La mesure de départ portait sur une régression : la forme nue `service
 * timestamps` était refusée alors qu'elle est légale sur IOS (elle vaut
 * `service timestamps debug uptime`). En mesurant autour, la commande
 * s'est révélée bien plus creuse que ce seul refus :
 *
 *  - **`uptime` était accepté et ne faisait rien.** `service timestamps
 *    log uptime` écrivait `*Aug  4 13:45:46:` — une date, c'est-à-dire
 *    exactement l'autre format. Le mot-clé qui choisit la forme était lu
 *    et jeté.
 *  - **La running-config ne rendait pas ce qui avait été tapé.** Toutes
 *    les formes acceptées revenaient en `service timestamps log datetime
 *    msec` : `log uptime` devenait une date, `log datetime` gagnait des
 *    millièmes, et le canal `debug` n'était rendu nulle part. Ce n'est pas
 *    cosmétique — la running-config est rejouée à l'import d'une
 *    topologie, donc le routeur relu n'était pas celui qu'on avait
 *    configuré.
 *  - **`localtime` et `show-timezone` étaient acceptés et ignorés**, alors
 *    que `clock timezone` existe déjà et porte la donnée qu'il leur faut.
 *  - **Le `*` était inconditionnel.** Sur un routeur il veut dire « heure
 *    non autoritaire » ; il était écrit même quand NTP était synchronisé,
 *    parce que le drapeau qui le gouvernait n'était posé par personne.
 *
 * Cette sonde reste dans l'arbre : elle décrit le contrat de la commande,
 * pas l'incident qui l'a fait écrire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });
afterEach(() => { vi.useRealTimers(); });

async function routeur(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  r.powerOn();
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('logging buffered 64000 debugging');
  return r;
}

/** Un shutdown produit un %LINEPROTO-5-UPDOWN, c'est-à-dire du canal `log`. */
async function messageDeLien(r: CiscoRouter): Promise<string> {
  const [g0] = r.getPortNames();
  await r.executeCommand('configure terminal');
  await r.executeCommand(`interface ${g0}`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('shutdown');
  await r.executeCommand('end');
  const journal = (await r.executeCommand('show logging')).split('\n');
  const ligne = journal.find((l) => l.includes('%LINEPROTO') || l.includes('%LINK'));
  expect(ligne, 'le banc doit produire au moins un message à horodater').toBeDefined();
  return ligne!;
}

async function configLines(r: CiscoRouter): Promise<string[]> {
  await r.executeCommand('end');
  return (await r.executeCommand('show running-config')).split('\n').map((l) => l.trim());
}

describe('service timestamps — grammaire', () => {
  it('la forme nue est acceptée et vaut `debug uptime` sur les deux canaux', async () => {
    const r = await routeur();
    // C'était la régression : IOS accepte la commande sans aucun mot-clé.
    expect(await r.executeCommand('service timestamps')).toBe('');
    const lignes = await configLines(r);
    expect(lignes).toContain('service timestamps debug uptime');
    expect(lignes).toContain('service timestamps log uptime');
  });

  it('un canal nommé sans format vaut `uptime`', async () => {
    const r = await routeur();
    expect(await r.executeCommand('service timestamps log')).toBe('');
    const lignes = await configLines(r);
    expect(lignes).toContain('service timestamps log uptime');
    expect(lignes).not.toContain('service timestamps debug uptime');
  });

  it('`no service timestamps` nu éteint les DEUX canaux', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps debug datetime');
    await r.executeCommand('service timestamps log datetime');
    expect(await r.executeCommand('no service timestamps')).toBe('');
    const lignes = await configLines(r);
    expect(lignes.filter((l) => l.startsWith('service timestamps'))).toEqual([]);
  });

  it('`no service timestamps log` ne touche pas le canal debug', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps debug datetime msec');
    await r.executeCommand('service timestamps log datetime msec');
    expect(await r.executeCommand('no service timestamps log')).toBe('');
    const lignes = await configLines(r);
    expect(lignes).toContain('service timestamps debug datetime msec');
    expect(lignes).not.toContain('service timestamps log datetime msec');
  });

  it('un mot inconnu est refusé plutôt que rangé', async () => {
    const r = await routeur();
    // Sans ce refus, une faute de frappe serait mémorisée comme une
    // option que rien ne lit — le défaut que cette sonde traque partout.
    expect(await r.executeCommand('service timestamps zorglub')).toContain('Invalid input');
    expect(await r.executeCommand('service timestamps log zorglub')).toContain('Invalid input');
    expect(await r.executeCommand('service timestamps log datetime zorglub')).toContain('Invalid input');
  });

  it('les options de date sont refusées derrière `uptime`', async () => {
    const r = await routeur();
    // `localtime` et `show-timezone` n'ont aucun sens sur un compteur
    // depuis le démarrage : les accepter poserait un drapeau illisible.
    expect(await r.executeCommand('service timestamps log uptime localtime')).toContain('Invalid input');
    expect(await r.executeCommand('service timestamps log uptime show-timezone')).toContain('Invalid input');
  });

  it('un format donné sans canal est refusé', async () => {
    const r = await routeur();
    expect(await r.executeCommand('service timestamps datetime msec')).toContain('Invalid input');
  });
});

describe('service timestamps — la running-config rend ce qui a été tapé', () => {
  it('chaque forme revient sous sa propre forme', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps debug datetime msec localtime show-timezone');
    await r.executeCommand('service timestamps log uptime');
    const lignes = await configLines(r);
    // Rendre `log uptime` en `log datetime msec` refabriquerait un autre
    // routeur à la relecture de la topologie.
    expect(lignes).toContain('service timestamps debug datetime msec localtime show-timezone');
    expect(lignes).toContain('service timestamps log uptime');
  });

  it('`datetime` sans `msec` ne gagne pas de millièmes au passage', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps log datetime');
    expect(await configLines(r)).toContain('service timestamps log datetime');
  });

  it('`year` est rendu', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps log datetime year');
    expect(await configLines(r)).toContain('service timestamps log datetime year');
  });
});

describe('service timestamps — la ligne écrite', () => {
  it('`uptime` écrit un compteur depuis le démarrage, pas une date', async () => {
    vi.useFakeTimers();
    const r = await routeur();
    await r.executeCommand('service timestamps log uptime');
    // Le compteur doit avancer : à zéro, une vraie mesure et une
    // constante seraient indiscernables.
    vi.setSystemTime(Date.now() + 3_723_000);
    const ligne = await messageDeLien(r);
    expect(ligne).toMatch(/^01:02:03: %/);
  });

  it('`uptime msec` ajoute les millièmes au compteur', async () => {
    vi.useFakeTimers();
    const r = await routeur();
    await r.executeCommand('service timestamps log uptime msec');
    vi.setSystemTime(Date.now() + 65_400);
    expect(await messageDeLien(r)).toMatch(/^00:01:05\.400: %/);
  });

  it('au-delà d\'un jour IOS abrège en `1d02h`, puis en `1w2d`', async () => {
    vi.useFakeTimers();
    const r = await routeur();
    await r.executeCommand('service timestamps log uptime');
    vi.setSystemTime(Date.now() + 26 * 3_600_000);
    expect(await messageDeLien(r)).toMatch(/^1d02h: %/);

    const r2 = await routeur();
    await r2.executeCommand('service timestamps log uptime');
    vi.setSystemTime(Date.now() + 9 * 86_400_000);
    expect(await messageDeLien(r2)).toMatch(/^1w2d: %/);
  });

  it('`datetime` écrit une date, avec le `*` tant que l\'heure n\'est pas autoritaire', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps log datetime msec');
    expect(await messageDeLien(r)).toMatch(/^\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3}: %/);
  });

  it('le `*` disparaît quand NTP est synchronisé', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps log datetime');
    await r.executeCommand('ntp master 5');
    // Référence : le même banc, sans NTP, garde le `*` — sinon un banc
    // mal monté et un marqueur cassé se ressembleraient.
    expect(await messageDeLien(r)).toMatch(/^ [A-Z][a-z]{2} /);

    const temoin = await routeur();
    await temoin.executeCommand('service timestamps log datetime');
    expect(await messageDeLien(temoin)).toMatch(/^\*[A-Z][a-z]{2} /);
  });

  it('`localtime` décale l\'heure du `clock timezone`, `show-timezone` la nomme', async () => {
    const r = await routeur();
    await r.executeCommand('clock timezone CET 1');
    await r.executeCommand('service timestamps log datetime localtime show-timezone');
    const ligne = await messageDeLien(r);
    expect(ligne).toMatch(/ CET: %/);

    const utc = await routeur();
    await utc.executeCommand('clock timezone CET 1');
    await utc.executeCommand('service timestamps log datetime show-timezone');
    const ligneUtc = await utc.executeCommand('show logging');
    // Sans `localtime`, IOS reste sur UTC : le fuseau est configuré et
    // n'est pas appliqué, ce qui est bien la différence entre les deux
    // mots-clés.
    expect(await messageDeLien(utc)).toMatch(/ UTC: %/);
    expect(ligneUtc).toContain('Timestamp logging');

    const heure = (l: string) => Number(/ (\d{2}):\d{2}:\d{2}/.exec(l)![1]);
    const ecart = (heure(ligne) - heure(await messageDeLien(utc)) + 24) % 24;
    expect(ecart, 'CET est à +1 de UTC').toBe(1);
  });

  it('`year` insère l\'année entre le jour et l\'heure', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps log datetime year');
    expect(await messageDeLien(r)).toMatch(/^\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{4} \d{2}:\d{2}:\d{2}: %/);
  });

  it('le canal `debug` ne couvre pas le canal `log`', async () => {
    const r = await routeur();
    // La configuration d'usine horodate les DEUX canaux ; on éteint le
    // canal `log` pour que ce qu'il reste ne puisse venir que de `debug`.
    await r.executeCommand('no service timestamps log');
    await r.executeCommand('service timestamps debug datetime msec');
    expect(await messageDeLien(r)).toMatch(/^%[A-Z]/);
  });

  it('changer de format ne réécrit pas ce qui est déjà journalisé', async () => {
    const r = await routeur();
    await r.executeCommand('service timestamps log uptime');
    const ancienne = await messageDeLien(r);
    expect(ancienne).toMatch(/^\d{2}:\d{2}:\d{2}: %/);

    await r.executeCommand('configure terminal');
    await r.executeCommand('service timestamps log datetime msec');
    await r.executeCommand('end');
    const journal = (await r.executeCommand('show logging')).split('\n');
    // Le tampon d'un vrai routeur contient des lignes déjà écrites : la
    // commande change ce qui vient, pas ce qui est passé.
    expect(journal).toContain(ancienne);
  });
});

describe('service timestamps — le commutateur en dit autant', () => {
  it('un Catalyst accepte la commande et la rend', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    sw.powerOn();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    expect(await sw.executeCommand('service timestamps log datetime msec')).toBe('');
    expect(await sw.executeCommand('service timestamps log zorglub')).toContain('Invalid input');
    await sw.executeCommand('end');
    const lignes = (await sw.executeCommand('show running-config')).split('\n').map((l) => l.trim());
    expect(lignes).toContain('service timestamps log datetime msec');
  });
});
