/**
 * La base de paquets DÉCRIT la machine, et `installed` en est DÉRIVÉ.
 *
 * Mesure de départ, sur une seule machine et au même instant :
 *
 *  - `apt install zorglub` répondait « zorglub is already the newest
 *    version. » pendant qu'`apt-cache policy zorglub` répondait
 *    « Unable to locate package zorglub ». Deux commandes, une question,
 *    deux réponses contraires ;
 *  - `apt install bind9` disait la même chose alors qu'`apt-cache
 *    policy bind9` disait `Installed: (none)`, et rien n'était installé ;
 *  - `apt install --version` prenait l'OPTION pour un nom de paquet
 *    (« --version is already the newest version ») — le code filtrait
 *    pourtant les options une ligne plus haut, puis ignorait le résultat ;
 *  - `apt remove curl` annonçait « 0 to remove » et `which curl`
 *    répondait toujours ;
 *  - `apt-cache search nginx` et `apt-cache search curl` ne rendaient
 *    RIEN alors que `which` situe les deux binaires — la base niait des
 *    logiciels que la machine exécute, ce que son propre en-tête décrit
 *    comme le défaut à ne pas commettre ;
 *  - `dpkg -l bind9` ignorait son argument et listait tout.
 *
 * La cause commune : `installed` était un booléen TENU À LA MAIN, donc
 * une seconde écriture d'un fait que la machine porte déjà. Il est
 * maintenant LU — un paquet est présent quand cette image livre au moins
 * une des commandes qu'il fournit — et la question « qui fournit quoi ? »
 * se pose à la COMMANDE : `LinuxCommand.package` la porte, et
 * `COMMAND_PACKAGES` répond pour celles restées dans le `switch` de
 * `LinuxCommandExecutor`, exactement comme les privilèges le font déjà.
 *
 * Discrimine par `git stash` : 10 cas tombent avant correctif.
 *
 * Le seul qui passe des deux côtés est nommé : « apt-cache policy
 * refuse un paquet inconnu » était le seul des trois outils qui disait
 * vrai, et il sert de TÉMOIN — sans lui on ne saurait pas si le refus
 * qu'on vient d'écrire dans `apt` dit la même chose que celui qui
 * existait déjà.
 *
 * Une remarque sur la rédaction, écrite plutôt que tue : le cas de
 * l'option a d'abord passé des DEUX côtés parce qu'il se contentait de
 * chercher `curl is already the newest version` dans la sortie, or
 * l'ancienne ligne `-y, curl is already the newest version.` la contient.
 * Il compare maintenant la LIGNE entière.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { PACKAGE_DB, packageProvides } from '@/network/devices/linux/packages/PackageDatabase';
import {
  packageOfCommand, shippedCommands, doublyDeclaredCommands,
} from '@/network/devices/linux/commands/LinuxCommandPackages';

function machine() { return new LinuxPC('linux-pc', 'srv1', 0, 0); }

describe('la base de paquets décrit la machine', () => {
  it('apt install refuse un paquet inconnu, comme apt-cache', async () => {
    const pc = machine();
    const out = await pc.executeCommand('apt install zorglub');
    expect(out).toContain('E: Unable to locate package zorglub');
    expect(out).not.toContain('already the newest version');
  });

  it('le TÉMOIN : apt-cache policy refusait déjà, lui', async () => {
    expect(await machine().executeCommand('apt-cache policy zorglub'))
      .toContain('Unable to locate package zorglub');
  });

  it('apt install nomme la VERSION du paquet installé', async () => {
    expect(await machine().executeCommand('apt install nginx'))
      .toContain('nginx is already the newest version (1.18.0-6ubuntu14.4).');
  });

  it('une option n est pas prise pour un paquet', async () => {
    const out = await machine().executeCommand('apt install -y curl');
    expect(out.split('\n')).toContain(
      'curl is already the newest version (7.81.0-1ubuntu1.15).');
    expect(out).not.toContain('-y');
  });

  it('apt-cache search trouve ce que la machine exécute', async () => {
    const pc = machine();
    expect(await pc.executeCommand('apt-cache search nginx')).toContain('nginx -');
    expect(await pc.executeCommand('apt-cache search curl')).toContain('curl -');
    expect(await pc.executeCommand('apt-cache search lldp')).toContain('lldpd -');
  });

  it('apt-cache policy dit installé pour ce qui tourne vraiment', async () => {
    const out = await machine().executeCommand('apt-cache policy bind9');
    expect(out).not.toContain('Installed: (none)');
    expect(out).toContain('Installed: 9.18.12-0ubuntu0.22.04.1');
  });

  it('dpkg -l filtre sur son argument', async () => {
    const pc = machine();
    const out = await pc.executeCommand('dpkg -l bind9');
    expect(out).toContain('bind9');
    expect(out).not.toContain('coreutils');
    expect(await pc.executeCommand('dpkg -l "lldp*"')).toContain('lldpd');
  });

  it('dpkg -l refuse un paquet absent au lieu de tout lister', async () => {
    const out = await machine().executeCommand('dpkg -l zorglub');
    expect(out).toContain('no packages found matching zorglub');
    expect(out).not.toContain('coreutils');
  });

  it('apt list --installed et dpkg -l s accordent', async () => {
    const pc = machine();
    const apt = (await pc.executeCommand('apt list --installed'))
      .split('\n').filter(l => l.includes('/jammy')).length;
    const dpkg = (await pc.executeCommand('dpkg -l'))
      .split('\n').filter(l => l.startsWith('ii ')).length;
    expect(apt).toBe(dpkg);
    expect(apt).toBeGreaterThan(40);
  });

  it('la table couvre ce que la machine livre, et rien de plus', () => {
    const orphelines = shippedCommands().filter(n => packageOfCommand(n) === undefined);
    expect(orphelines).toEqual([]);
    const vides = PACKAGE_DB.filter(p => packageProvides(p.name).length === 0);
    expect(vides.map(p => p.name)).toEqual([]);
  });

  it('une commande déclare son paquet ELLE-MÊME quand elle a un objet', () => {
    expect(packageOfCommand('conntrack')).toBe('conntrack');
    expect(packageOfCommand('nginx')).toBe('nginx');
    expect(packageProvides('conntrack')).toEqual(['conntrack']);
  });

  it('aucun nom n est déclaré des DEUX côtés', () => {
    expect(doublyDeclaredCommands()).toEqual([]);
  });
});
