/*
 * Le code retour (%errorlevel%) d'une commande est celui QUE LA COMMANDE
 * rend, pas une devinette sur le texte qu'elle a ecrit.
 *
 * Mesure de depart : `findstr zzz f && echo found || echo missing` ecrivait
 * « found » — le code retour d'une commande externe etait deduit de la
 * premiere ligne de sa sortie (`error:`, « cannot find », « access is
 * denied »…) ; une commande qui ne trouve rien et n'ecrit rien rendait donc
 * 0. Meme defaut pour `find` sans correspondance, `fc` de deux fichiers qui
 * different, `ping` d'une adresse qui ne repond pas (« transmit failed »),
 * `net user` d'un compte inconnu, `sc query` d'un service inconnu et `mkdir`
 * d'un dossier qui existe.
 *
 * L'AUTORITE — les pages de commande de Microsoft : `find` rend 0 si une
 * ligne correspond, 1 sinon, 2 sur une erreur ; `findstr` 0, 1 ou 2 de meme ;
 * `fc` 0 (identiques), 1 (differents), 2 (fichier introuvable), -1 (syntaxe) ;
 * `ping` rend 1 quand aucune reponse n'est recue ; `net` rend 2 pour toute
 * erreur, dont le numero NET HELPMSG ; `sc` rend le code d'erreur Windows de
 * l'echec (1060 : « service does not exist ») ; `mkdir` sur un dossier
 * existant 1. Le 0 de `ping` quand le routeur repond « Destination host
 * unreachable » est le defaut connu de ping.exe, que le simulateur garde : la
 * reponse du routeur compte comme recue.
 *
 * Ecrite a l'aveugle, sur `executeCmdCommand`. 9 des 11 cas tombent avant (git
 * stash push -- src/network). Les 2 qui passent des deux cotes sont des
 * TEMOINS : les commandes dont le texte trahissait deja l'echec (`type`,
 * `copy`, `reg query`) gardent leur 1 et `hostname` son 0, et un `tasklist`
 * sans correspondance garde son 0 — sans eux, un code retour force a 1
 * partout passerait les neuf autres cas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-RC');
  pc.setCurrentUser('Administrator');
  for (const step of ['mkdir C:\\lab', 'cd C:\\lab', 'echo abc> a.txt', 'echo abd> b.txt']) await pc.executeCmdCommand(step);
  return pc;
}

async function codeAfter(command: string): Promise<string> {
  const pc = await lab();
  await pc.executeCmdCommand(command);
  return pc.executeCmdCommand('echo %errorlevel%');
}

describe('findstr and find', () => {
  it('findstr: 0 when a line matches, 1 when none does, 2 when the file cannot be read', async () => {
    expect(await codeAfter('findstr abc a.txt')).toBe('0');
    expect(await codeAfter('findstr zzz a.txt')).toBe('1');
    expect(await codeAfter('findstr abc nosuch.txt')).toBe('2');
  });

  it('find: 0 when a line matches, 1 when none does, 2 when the file cannot be read', async () => {
    expect(await codeAfter('find "abc" a.txt')).toBe('0');
    expect(await codeAfter('find "zzz" a.txt')).toBe('1');
    expect(await codeAfter('find /c "zzz" a.txt')).toBe('1');
    expect(await codeAfter('find "abc" nosuch.txt')).toBe('2');
  });

  it('feeds the && / || idiom', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('findstr zzz a.txt && echo found || echo missing')).toBe('missing');
    expect(await pc.executeCmdCommand('findstr abc a.txt && echo found || echo missing')).toBe('abc\nfound');
  });

  it('applies to a filter at the end of a pipe', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('type a.txt | findstr zzz && echo found || echo missing')).toBe('missing');
  });
});

describe('fc', () => {
  it('rends 0 for identical files, 1 for different ones, 2 for a missing one', async () => {
    expect(await codeAfter('fc a.txt a.txt')).toBe('0');
    expect(await codeAfter('fc a.txt b.txt')).toBe('1');
    expect(await codeAfter('fc a.txt nosuch.txt')).toBe('2');
  });
});

describe('ping, net, sc and mkdir', () => {
  it('ping: 1 when nothing answers', async () => {
    expect(await codeAfter('ping -n 1 10.9.9.9')).toBe('1');
  });

  it('net: 2 on an error', async () => {
    expect(await codeAfter('net user nosuchuser')).toBe('2');
  });

  it('sc: the Windows error code of the failure', async () => {
    expect(await codeAfter('sc query nosuchsvc')).toBe('1060');
  });

  it('mkdir: 1 on a directory that already exists', async () => {
    expect(await codeAfter('mkdir C:\\lab')).toBe('1');
  });
});

describe('what already worked', () => {
  it('keeps 0 for commands that succeed, and 1 for the ones the output text already betrayed — WITNESS', async () => {
    expect(await codeAfter('hostname')).toBe('0');
    expect(await codeAfter('type a.txt')).toBe('0');
    expect(await codeAfter('type nosuch.txt')).toBe('1');
    expect(await codeAfter('copy nosuch.txt x.txt')).toBe('1');
    expect(await codeAfter('reg query HKLM\\Nope')).toBe('1');
  });

  it('keeps 0 for a tasklist that matches nothing — WITNESS', async () => {
    expect(await codeAfter('tasklist /fi "imagename eq nosuch.exe"')).toBe('0');
  });
});
