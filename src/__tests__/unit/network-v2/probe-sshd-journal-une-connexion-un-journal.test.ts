/**
 * Sonde — le journal d'auth de sshd decrit UNE connexion, dans l'ordre d'OpenSSH 8.9.
 *
 * Mesure de depart (sur 11c8e6250), pour un `ssh user@host true` :
 *   - `Connection from 10.0.0.1 port 22 on PC2 port 22` : le port est celui du SERVEUR
 *     (le client est 32770) et la ligne figure au niveau INFO, alors qu'OpenSSH ne
 *     l'ecrit qu'a `LogLevel VERBOSE`, avec ` rdomain ""` en fin de ligne ;
 *   - `Disconnected from user` ecrit DEUX fois, la seconde avec un port perime (le
 *     repli en memoire de `runSshClient` emettait sa propre deconnexion, puis oubliait
 *     le port que la connexion reelle allait lire a sa fermeture) ;
 *   - `session closed` AVANT `Disconnected from user`, et les lignes de systemd-logind
 *     AVANT `session closed`, a l'inverse d'OpenSSH ;
 *   - aucune ligne `Received disconnect from <ip> port <port>:11: disconnected by user`.
 *   - `ssh -f -N hote` sans redirection laissait la connexion reelle se fermer au retour
 *     (`Disconnected from user` journalise) alors que le dossier de session restait ouvert
 *     a jamais dans `who` : deux vues contradictoires de la meme connexion.
 *
 * Mesure avant correctif (la sonde rejouee avec les sources de 11c8e6250) : 6 cas sur 7
 * tombent. Seul le TEMOIN passe a l'identique : `Accepted password` est ecrit, donc le labo
 * est sain et les absences constatees ailleurs ne sont pas un journal vide.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildLan, assignIps, PC2_IP, sshExec, type SshLan } from './ssh-lan-fixtures';
import { logSshdVerbosely } from './sshdVerboseLog';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
});

async function sshdLines(): Promise<string[]> {
  const log = await lan.pc2.executeCommand('sudo cat /var/log/auth.log');
  return log.split('\n').filter((line) => /sshd\[|systemd-logind/.test(line));
}

const indexOf = (lines: string[], pattern: RegExp): number => lines.findIndex((line) => pattern.test(line));

describe('une connexion SSH reelle, vue dans auth.log', () => {
  it('TEMOIN -- la connexion est journalisee comme acceptee', async () => {
    await sshExec(lan.pc1, PC2_IP, 'true');
    expect((await sshdLines()).some((line) => /Accepted password for user from 10\.0\.0\.1 port \d+ ssh2/.test(line))).toBe(true);
  });

  it('au niveau INFO, `Connection from` n\'est pas ecrit', async () => {
    await sshExec(lan.pc1, PC2_IP, 'true');
    expect((await sshdLines()).some((line) => /Connection from/.test(line))).toBe(false);
  });

  it('a LogLevel VERBOSE, `Connection from` nomme le port du CLIENT et se termine par rdomain', async () => {
    await logSshdVerbosely(lan.pc2);
    await sshExec(lan.pc1, PC2_IP, 'true');
    const lines = await sshdLines();
    const accepted = lines.find((line) => /Accepted password/.test(line))!;
    const port = /port (\d+) ssh2/.exec(accepted)![1];
    expect(lines.some((line) => line.endsWith(`Connection from 10.0.0.1 port ${port} on PC2 port 22 rdomain ""`))).toBe(true);
  });

  it('la fin est dans l\'ordre d\'OpenSSH : Received disconnect, Disconnected, session closed', async () => {
    await sshExec(lan.pc1, PC2_IP, 'true');
    const lines = await sshdLines();
    const received = indexOf(lines, /Received disconnect from 10\.0\.0\.1 port \d+:11: disconnected by user$/);
    const disconnected = indexOf(lines, /Disconnected from user user 10\.0\.0\.1 port \d+$/);
    const closed = indexOf(lines, /pam_unix\(sshd:session\): session closed for user user/);
    expect(received).toBeGreaterThan(-1);
    expect(disconnected).toBe(received + 1);
    expect(closed).toBe(disconnected + 1);
  });
});

describe('`ssh user@host true` par executeCommand : le repli en memoire ne journalise pas une seconde fois', () => {
  it('une seule ligne `Disconnected from user`, avec le port de la connexion', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    await settle();
    const lines = await sshdLines();
    const accepted = lines.filter((line) => /Accepted password/.test(line));
    const disconnected = lines.filter((line) => /Disconnected from user/.test(line));
    expect(accepted).toHaveLength(1);
    expect(disconnected).toHaveLength(1);
    const port = /port (\d+) ssh2/.exec(accepted[0])![1];
    expect(disconnected[0].endsWith(`port ${port}`)).toBe(true);
  });

  it('les lignes de systemd-logind suivent `session closed`, comme dans un vrai journal', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} true`, 'admin\n');
    await settle();
    const lines = await sshdLines();
    const closed = indexOf(lines, /pam_unix\(sshd:session\): session closed/);
    const loggedOut = indexOf(lines, /Session \d+ logged out/);
    expect(closed).toBeGreaterThan(-1);
    expect(loggedOut).toBeGreaterThan(closed);
  });
});

describe('`ssh -f -N` sans redirection', () => {
  it('garde la connexion reelle ouverte : la session reste dans `who`, et aucune deconnexion n\'est journalisee', async () => {
    await lan.pc1.executeCommand(`ssh -f -N user@${PC2_IP}`, 'admin\n');
    await settle();
    expect(await lan.pc2.executeCommand('who')).toMatch(/user\s+pts\/\d+.*10\.0\.0\.1/);
    expect((await sshdLines()).some((line) => /Disconnected from user/.test(line))).toBe(false);
  });
});
