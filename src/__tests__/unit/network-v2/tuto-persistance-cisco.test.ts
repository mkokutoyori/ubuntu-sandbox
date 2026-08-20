/**
 * Le tutoriel « Persistance des données sur Cisco », joué comme un
 * laboratoire.
 *
 * Mesuré avant d'écrire une ligne, en rejouant les dix parties. Cinq
 * défauts, du plus grave au plus discret :
 *
 * 1. **`flash:` était PAR SESSION.** Le système de fichiers vivait sur
 *    le shell, et `createVtyShell()` en fabrique un neuf par session :
 *    un fichier copié depuis la console n'existait pas pour SSH. Pire,
 *    sur la même session `show archive` listait une archive que
 *    `dir flash:` niait — deux vues d'une machine qui ne peuvent pas
 *    avoir raison ensemble.
 * 2. **`copy running-config flash:X` mentait.** Elle répondait
 *    `Writing flash:X ... [OK]` en écrivant dans une Map à part, si
 *    bien que `dir flash:` ne montrait rien. Une sauvegarde qui
 *    s'annonce réussie et n'a rien écrit ne se découvre qu'au moment de
 *    restaurer.
 * 3. **`configure replace` n'existait pas** — donc toute la moitié
 *    « restauration » du tutoriel était injouable, et rien ne
 *    distinguait le MERGE de `copy` du REPLACE.
 * 4. **Les deux lignes d'audit n'existaient pas.**
 *    `! Last configuration change` / `! NVRAM config last updated`
 *    sont le signal du chapitre : deux dates différentes veulent dire
 *    qu'on a modifié sans sauvegarder. La question ne pouvait pas être
 *    posée à la machine.
 * 5. **`$h` n'était pas développé** dans `archive path` : le fichier
 *    s'appelait littéralement `$h-config-1`, sur toutes les machines.
 *
 * Et le registre de configuration était écrit EN DUR dans
 * `show version` (`0x2102`) pendant que `show bootvar` rendait la vraie
 * valeur sur la même machine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Vty { execute(c: string): Promise<string> | string }

async function routeur(nom = 'R1-PROD'): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  r.powerOn();
  for (const c of [
    'enable', 'configure terminal', `hostname ${nom}`,
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit', 'end',
  ]) await r.executeCommand(c);
  return r;
}

describe('Partie 1-2 — les mémoires et ce qui les distingue', () => {
  it('`show startup-config` est absente tant que rien n\'a été sauvegardé', async () => {
    const r = await routeur();
    expect(await r.executeCommand('show startup-config')).toContain('startup-config is not present');
    await r.executeCommand('write memory');
    expect(await r.executeCommand('show startup-config')).toMatch(/Using \d+ out of \d+ bytes/);
  }, 30_000);

  it('les deux lignes d\'audit existent, et leur ÉCART est le signal', async () => {
    const r = await routeur();
    const entete = await r.executeCommand('show running-config | include Last|NVRAM');
    // Avant toute sauvegarde : la configuration a changé, la NVRAM
    // n'a jamais été écrite — IOS n'invente pas la seconde ligne.
    expect(entete).toMatch(/! Last configuration change at .* by console/);
    expect(entete).not.toContain('NVRAM config last updated');

    await r.executeCommand('write memory');
    const apres = await r.executeCommand('show running-config | include Last|NVRAM');
    expect(apres).toMatch(/! NVRAM config last updated at .* by console/);
  }, 30_000);

  it('la comparaison running/startup montre ce qui n\'est pas sauvegardé', async () => {
    const r = await routeur();
    await r.executeCommand('write memory');
    expect(await r.executeCommand(
      'show archive config differences nvram:startup-config system:running-config'))
      .toContain('No changes were found');

    for (const c of [
      'configure terminal', 'interface GigabitEthernet0/2',
      'description Nouveau lien vers SW3', 'end',
    ]) await r.executeCommand(c);

    const diff = await r.executeCommand(
      'show archive config differences nvram:startup-config system:running-config');
    expect(diff).toContain('Contextual Config Diffs');
    expect(diff).toContain('+ description Nouveau lien vers SW3');
  }, 30_000);
});

describe('Partie 3 — sauvegarder', () => {
  it('`copy running-config flash:` ÉCRIT vraiment, et `dir` le voit', async () => {
    const r = await routeur();
    const out = await r.executeCommand('copy running-config flash:R1-PROD-20260809.cfg');
    expect(out).toContain('Destination filename [R1-PROD-20260809.cfg]?');
    expect(out).toMatch(/\d+ bytes copied/);
    // C'était le défaut : `[OK]` sans fichier.
    expect(await r.executeCommand('dir flash:')).toContain('R1-PROD-20260809.cfg');
    expect(await r.executeCommand('more flash:R1-PROD-20260809.cfg')).toContain('hostname R1-PROD');
  }, 30_000);

  it('une flash pleine refuse la copie au lieu de la perdre en silence', async () => {
    const r = await routeur();
    const fs = (r as unknown as {
      _getCiscoFileSystem(p: string): { write(n: string, c: string): void; freeBytes(): number };
    })._getCiscoFileSystem('router-isr2911');
    fs.write('bourrage', 'x'.repeat(fs.freeBytes()));
    expect(await r.executeCommand('copy running-config flash:trop.cfg'))
      .toContain('No space left on device');
  }, 30_000);

  /**
   * `tftp:` a quitté cette liste : le lot 2 lui a donné un vrai
   * transfert, mesuré par `cisco-copy-tftp-sur-le-fil.test.ts`. Sans ce
   * client, un routeur n'avait AUCUNE façon d'ouvrir un port UDP. Ce
   * qu'il reste ici est ce qui manque toujours, et les deux moitiés
   * comptent : un protocole absent le dit, une URL mal formée nomme la
   * forme attendue au lieu de répondre `[OK]`.
   */
  it('une copie réseau DIT ce qui manque au lieu de répondre [OK]', async () => {
    const r = await routeur();
    for (const cible of ['ftp:', 'scp:']) {
      const out = await r.executeCommand(`copy running-config ${cible}`);
      expect(out, cible).toContain('not implemented in this simulator');
      expect(out, cible).not.toMatch(/\[OK\]/);
    }
    const tftp = await r.executeCommand('copy running-config tftp:');
    expect(tftp).toContain('tftp://<address>/<filename>');
    expect(tftp).not.toMatch(/\[OK\]/);
  }, 30_000);

  it('`write memory` et `copy running-config startup-config` font la même chose', async () => {
    const r = await routeur();
    await r.executeCommand('write memory');
    const parWrite = await r.executeCommand('show startup-config');
    for (const c of ['configure terminal', 'interface GigabitEthernet0/1',
      'description X', 'end']) await r.executeCommand(c);
    await r.executeCommand('copy running-config startup-config');
    const parCopy = await r.executeCommand('show startup-config');
    expect(parCopy).toContain('description X');
    expect(parWrite).not.toContain('description X');
  }, 30_000);
});

describe('Partie 4 — restaurer, et la différence entre MERGE et REPLACE', () => {
  it('`configure replace` SUPPRIME ce que `copy` aurait laissé', async () => {
    const r = await routeur();
    await r.executeCommand('copy running-config flash:base.cfg');
    for (const c of [
      'configure terminal', 'interface GigabitEthernet0/1',
      'description A SUPPRIMER', 'ip address 172.16.9.9 255.255.255.0', 'end',
    ]) await r.executeCommand(c);

    // `copy` fusionne : la ligne en trop RESTE.
    await r.executeCommand('copy flash:base.cfg running-config');
    expect(await r.executeCommand('show running-config')).toContain('172.16.9.9');

    // `configure replace` remplace : elle disparaît.
    await r.executeCommand('configure replace flash:base.cfg force');
    const apres = await r.executeCommand('show running-config');
    expect(apres).not.toContain('172.16.9.9');
    expect(apres).not.toContain('A SUPPRIMER');
    expect(apres).toContain('10.0.0.1');
  }, 30_000);

  it('`list` montre le plan et n\'applique RIEN', async () => {
    const r = await routeur();
    await r.executeCommand('copy running-config flash:base.cfg');
    for (const c of ['configure terminal', 'interface GigabitEthernet0/1',
      'ip address 172.16.9.9 255.255.255.0', 'end']) await r.executeCommand(c);

    const plan = await r.executeCommand('configure replace flash:base.cfg list');
    expect(plan).toContain('!List of Commands:');
    expect(plan).toContain('no ip address 172.16.9.9 255.255.255.0');
    // Simulation : la configuration n'a pas bougé.
    expect(await r.executeCommand('show running-config')).toContain('172.16.9.9');
  }, 30_000);

  it('la bannière n\'apparaît que sans `force`, et `time` est accepté', async () => {
    const r = await routeur();
    await r.executeCommand('copy running-config flash:base.cfg');
    expect(await r.executeCommand('configure replace flash:base.cfg'))
      .toContain('This will apply all necessary additions and deletions');
    expect(await r.executeCommand('configure replace flash:base.cfg force'))
      .not.toContain('This will apply');
    expect(await r.executeCommand('configure replace flash:base.cfg time 30'))
      .toContain('rollback will automatically be triggered in 30 minutes');
  }, 30_000);

  it('`configure replace nvram:startup-config` revient à la sauvegarde', async () => {
    const r = await routeur();
    await r.executeCommand('write memory');
    for (const c of ['configure terminal', 'interface GigabitEthernet0/2',
      'description CASSE', 'end']) await r.executeCommand(c);
    await r.executeCommand('configure replace nvram:startup-config force');
    expect(await r.executeCommand(
      'show archive config differences nvram:startup-config system:running-config'))
      .toContain('No changes were found');
  }, 30_000);

  it('un fichier qui n\'existe pas est refusé, pas appliqué à moitié', async () => {
    const r = await routeur();
    expect(await r.executeCommand('configure replace flash:fantome.cfg force'))
      .toContain('%Error opening flash:fantome.cfg (No such file or directory)');
  }, 30_000);
});

describe('Partie 5 — archive', () => {
  it('`$h` devient le nom de la machine dans le chemin', async () => {
    const r = await routeur();
    for (const c of [
      'configure terminal', 'archive', 'path flash:archive/$h-config',
      'maximum 5', 'write-memory', 'exit', 'end',
    ]) await r.executeCommand(c);
    await r.executeCommand('write memory');

    const archive = await r.executeCommand('show archive');
    expect(archive).toContain('flash:archive/R1-PROD-config-1');
    expect(archive).not.toContain('$h');
    expect(await r.executeCommand('dir flash:archive/')).toContain('R1-PROD-config-1');
  }, 30_000);

  it('`show archive` a la forme d\'IOS, marque récent compris', async () => {
    const r = await routeur();
    for (const c of ['configure terminal', 'archive', 'path flash:archive/$h-config',
      'maximum 5', 'write-memory', 'exit', 'end']) await r.executeCommand(c);
    await r.executeCommand('write memory');
    for (const c of ['configure terminal', 'interface GigabitEthernet0/1',
      'description deux', 'end']) await r.executeCommand(c);
    await r.executeCommand('write memory');

    const out = await r.executeCommand('show archive');
    expect(out).toContain('The maximum archive configurations allowed is 5.');
    expect(out).toContain('There are currently 2 archive configurations saved.');
    expect(out).toContain('The next archive file will be named flash:archive/R1-PROD-config-3');
    expect(out).toContain(' Archive #  Name');
    expect(out).toMatch(/2\s+flash:archive\/R1-PROD-config-2 <- Most Recent/);
  }, 30_000);

  it('deux archives se comparent par leur NUMÉRO', async () => {
    const r = await routeur();
    for (const c of ['configure terminal', 'archive', 'path flash:archive/$h-config',
      'write-memory', 'exit', 'end']) await r.executeCommand(c);
    await r.executeCommand('write memory');
    for (const c of ['configure terminal', 'interface GigabitEthernet0/2',
      'description Lien vers SW3', 'end']) await r.executeCommand(c);
    await r.executeCommand('write memory');

    const diff = await r.executeCommand('show archive config differences 1 2');
    expect(diff).toContain('+ description Lien vers SW3');
  }, 30_000);

  it('`configure replace archive:N` revient à une version précédente', async () => {
    const r = await routeur();
    for (const c of ['configure terminal', 'archive', 'path flash:archive/$h-config',
      'write-memory', 'exit', 'end']) await r.executeCommand(c);
    await r.executeCommand('write memory');
    for (const c of ['configure terminal', 'interface GigabitEthernet0/2',
      'description MAUVAISE MANIP', 'end']) await r.executeCommand(c);
    await r.executeCommand('write memory');

    expect(await r.executeCommand('show running-config')).toContain('MAUVAISE MANIP');
    await r.executeCommand('configure replace archive:1 force');
    expect(await r.executeCommand('show running-config')).not.toContain('MAUVAISE MANIP');
  }, 30_000);

  it('`maximum` supprime la plus ancienne au lieu de l\'oublier', async () => {
    const r = await routeur();
    for (const c of ['configure terminal', 'archive', 'path flash:archive/$h-config',
      'maximum 2', 'write-memory', 'exit', 'end']) await r.executeCommand(c);
    for (let i = 0; i < 3; i++) {
      for (const c of ['configure terminal', 'interface GigabitEthernet0/1',
        `description v${i}`, 'end']) await r.executeCommand(c);
      await r.executeCommand('write memory');
    }
    const out = await r.executeCommand('show archive');
    expect(out).toContain('There are currently 2 archive configurations saved.');
    // Le fichier de la première version a VRAIMENT disparu du flash:
    expect(await r.executeCommand('dir flash:archive/')).not.toContain('R1-PROD-config-1');
  }, 30_000);

  it('`show archive log config` retient qui a tapé quoi', async () => {
    const r = await routeur();
    for (const c of ['configure terminal', 'archive', 'log config',
      'logging enable', 'hidekeys', 'exit', 'exit', 'end']) await r.executeCommand(c);
    for (const c of ['configure terminal', 'interface GigabitEthernet0/2',
      'description trace', 'end']) await r.executeCommand(c);
    const journal = await r.executeCommand('show archive log config all');
    expect(journal).toContain('Logged command');
    expect(journal).toContain('description trace');
    expect(journal).toContain('console@console');
  }, 30_000);
});

describe('Partie 6 — la flash est une, et elle a des répertoires', () => {
  it('toutes les sessions de la machine voient le MÊME flash:', async () => {
    const r = await routeur();
    await r.executeCommand('copy running-config flash:depuis-console.cfg');
    const vty = (r as unknown as { createVtyShell(u?: string): Vty }).createVtyShell('admin');
    await vty.execute('enable');
    // Le défaut : le shell portait son propre système de fichiers.
    expect(await vty.execute('dir flash:')).toContain('depuis-console.cfg');
    await vty.execute('copy running-config flash:depuis-ssh.cfg');
    expect(await r.executeCommand('dir flash:')).toContain('depuis-ssh.cfg');
  }, 30_000);

  it('`mkdir` / `rmdir` existent et refusent un répertoire non vide', async () => {
    const r = await routeur();
    expect(await r.executeCommand('mkdir flash:backups')).toContain('Created dir flash:backups');
    expect(await r.executeCommand('dir flash:')).toMatch(/drwx\s+0\s+.*backups/);
    await r.executeCommand('copy running-config flash:backups/x.cfg');
    expect(await r.executeCommand('rmdir flash:backups')).toContain('Directory not empty');
    await r.executeCommand('delete flash:backups/x.cfg');
    expect(await r.executeCommand('rmdir flash:backups')).toContain('Removed dir');
  }, 30_000);

  it('`squeeze` dit la vérité sur un système qui libère à la suppression', async () => {
    const r = await routeur();
    const out = await r.executeCommand('squeeze flash:');
    expect(out).toContain('Squeeze of flash complete');
    expect(out).toContain('reclaims space on delete');
  }, 30_000);

  it('`verify /md5` calcule sur le contenu réel du fichier', async () => {
    const r = await routeur();
    await r.executeCommand('copy running-config flash:a.cfg');
    await r.executeCommand('copy running-config flash:b.cfg');
    const somme = (t: string) => /Computed Hash {3}MD5 : ([0-9a-f]+)/.exec(t)?.[1];
    const a = somme(await r.executeCommand('verify /md5 flash:a.cfg'));
    const b = somme(await r.executeCommand('verify /md5 flash:b.cfg'));
    expect(a).toBeTruthy();
    // Même contenu, même somme — c'est ce qu'une somme mesure.
    expect(a).toBe(b);
    for (const c of ['configure terminal', 'interface GigabitEthernet0/1',
      'description change', 'end']) await r.executeCommand(c);
    await r.executeCommand('copy running-config flash:c.cfg');
    expect(somme(await r.executeCommand('verify /md5 flash:c.cfg'))).not.toBe(a);
  }, 30_000);
});

describe('Partie 7 — le registre de configuration', () => {
  it('`show version` lit la VRAIE valeur, et annonce celle du prochain boot', async () => {
    const r = await routeur();
    expect(await r.executeCommand('show version | include Configuration register'))
      .toBe('Configuration register is 0x2102');

    for (const c of ['configure terminal', 'config-register 0x2142', 'end']) {
      await r.executeCommand(c);
    }
    // IOS ne change PAS la machine qui tourne : il prépare le prochain
    // démarrage. Les confondre rendrait l'exercice incompréhensible.
    expect(await r.executeCommand('show version | include Configuration register'))
      .toBe('Configuration register is 0x2102 (will be 0x2142 at next reload)');
    expect(await r.executeCommand('show bootvar'))
      .toContain('(will be 0x2142 at next reload)');
  }, 30_000);

  it('`show version` et `show bootvar` ne peuvent plus se contredire', async () => {
    const r = await routeur();
    for (const c of ['configure terminal', 'config-register 0x2101', 'end']) {
      await r.executeCommand(c);
    }
    const version = await r.executeCommand('show version | include Configuration register');
    const bootvar = (await r.executeCommand('show bootvar'))
      .split('\n').find((l) => l.includes('Configuration register'));
    expect(version).toBe(bootvar);
  }, 30_000);
});

describe('Partie 9 — récupération', () => {
  it('`write erase` vide la NVRAM et laisse la RAM intacte', async () => {
    const r = await routeur();
    await r.executeCommand('write memory');
    await r.executeCommand('write erase');
    expect(await r.executeCommand('show startup-config')).toContain('not present');
    // La running-config est toujours là — c'est ce qui rend la
    // récupération possible.
    expect(await r.executeCommand('show running-config')).toContain('hostname R1-PROD');
    await r.executeCommand('copy running-config startup-config');
    expect(await r.executeCommand('show startup-config')).toContain('hostname R1-PROD');
  }, 30_000);
});

describe('Partie 5 — le journal des commandes a les formes d\'IOS', () => {
  async function journalise(): Promise<CiscoRouter> {
    const r = await routeur();
    for (const c of [
      'configure terminal', 'archive', 'log config', 'logging enable',
      'logging size 500', 'hidekeys', 'exit', 'exit',
      'ip domain-name lab.local', 'ip name-server 8.8.8.8',
      'ip route 192.168.9.0 255.255.255.0 10.0.0.2', 'end',
    ]) await r.executeCommand(c);
    return r;
  }

  it('`all` liste tout, un numéro seul démarre à ce numéro', async () => {
    const r = await journalise();
    const tout = await r.executeCommand('show archive log config all');
    expect(tout).toContain('ip domain-name lab.local');
    expect(tout).toContain('ip name-server 8.8.8.8');
    const depuis = await r.executeCommand('show archive log config 5');
    expect(depuis).not.toContain('logging enable');
  }, 30_000);

  /**
   * La borne de fin était ignorée : `show archive log config 2 3` rendait
   * tout à partir de 2, donc une plage n'en était pas une.
   */
  it('deux numéros sont une PLAGE, borne de fin comprise', async () => {
    const r = await journalise();
    const plage = await r.executeCommand('show archive log config 5 6');
    const lignes = plage.split('\n').filter((l) => l.includes('|'));
    expect(lignes.length).toBe(2);
  }, 30_000);

  /**
   * `provisioning` rend le journal SOUS LA FORME d'un fichier de
   * configuration — c'est ce que le mot veut dire, et c'est ce qui le
   * rend utile : on recolle la sortie dans un terminal. Il était accepté
   * et jeté, donc la vue était identique à celle sans le mot.
   */
  it('`provisioning` rend les commandes seules, sans les colonnes', async () => {
    const r = await journalise();
    const brut = await r.executeCommand('show archive log config all provisioning');
    expect(brut).not.toContain('Logged command');
    expect(brut).not.toContain('|');
    expect(brut).toContain('ip domain-name lab.local');
  }, 30_000);

  it('`statistics` compte, il ne liste pas', async () => {
    const r = await journalise();
    const stats = await r.executeCommand('show archive log config statistics');
    expect(stats).toContain('Number of entries in the log-queue');
    expect(stats).not.toContain('ip domain-name lab.local');
  }, 30_000);

  it('`user <nom>` restreint à cet opérateur', async () => {
    const r = await journalise();
    expect(await r.executeCommand('show archive log config user console all'))
      .toContain('ip domain-name lab.local');
    const autre = await r.executeCommand('show archive log config user personne all');
    expect(autre).not.toContain('ip domain-name lab.local');
  }, 30_000);

  /**
   * `last` n'existe sur AUCUN IOS — la syntaxe est `all`, un numéro, une
   * plage, ou `user`/`statistics`. Le refuser EST la fidélité, comme
   * pour `| head` que ce tutoriel emploie aussi.
   */
  it('`last N` est refusé, parce qu\'IOS ne le connaît pas', async () => {
    const r = await journalise();
    expect(await r.executeCommand('show archive log config last 1'))
      .toContain('% Invalid input detected');
  }, 30_000);

  it('`contenttype` est accepté et une valeur inconnue refusée', async () => {
    const r = await journalise();
    expect(await r.executeCommand('show archive log config all contenttype plaintext'))
      .toContain('ip domain-name lab.local');
    expect(await r.executeCommand('show archive log config all contenttype json'))
      .toContain('% Invalid input detected');
  }, 30_000);
});

describe('Partie 6 — `delete` confirme, comme toute commande destructrice', () => {
  it('une suppression muette est celle qu\'on croit avoir annulée', async () => {
    const r = await routeur();
    await r.executeCommand('copy running-config flash:jetable.cfg');
    const out = await r.executeCommand('delete flash:jetable.cfg');
    expect(out).toContain('Delete filename [jetable.cfg]?');
    expect(out).toContain('Delete flash:/jetable.cfg? [confirm]');
    expect(await r.executeCommand('dir flash:')).not.toContain('jetable.cfg');
  }, 30_000);

  it('un fichier absent est rapporté et ne confirme rien', async () => {
    const r = await routeur();
    const out = await r.executeCommand('delete flash:jamais.cfg');
    expect(out).toContain('No such file or directory');
    expect(out).not.toContain('[confirm]');
  }, 30_000);
});
