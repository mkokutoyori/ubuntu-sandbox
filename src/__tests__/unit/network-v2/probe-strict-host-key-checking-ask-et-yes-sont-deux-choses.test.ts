/**
 * Sonde — `StrictHostKeyChecking` : `ask` (le defaut d'OpenSSH) et `yes` sont deux modes.
 *
 * Mesure de depart (sur 39136c186) : `ask` etait lu comme `yes`
 * (`STRICT_HOST_KEY_MODES` de sshArgs) et `yes` PROPOSAIT la question « Are you sure you
 * want to continue connecting » au lieu de refuser ; `true`/`false`/`off` de ~/.ssh/config
 * etaient passes tels quels a la fabrique de strategies, qui ne les connaissait pas ; le
 * defaut d'un terminal etait `accept-new`, si bien qu'une premiere connexion enregistrait
 * la cle sans rien demander ; et `ssh -o StrictHostKeyChecking=yes` par `executeCommand`
 * ajoutait une ligne « No matching host key fingerprint found in DNS. » que ssh n'ecrit
 * qu'avec VerifyHostKeyDNS.
 *
 * Mesure avant correctif (la sonde rejouee avec les sources de 39136c186) : 5 cas sur 9
 * tombent. Passent a l'identique, et c'est dit : les TEMOINS (`accept-new` et `no`
 * connectent, un hote connu passe sous `yes`) et « true vaut yes » (les deux sorties
 * etaient la meme ligne fautive, donc egales). Le defaut `ask` d'un terminal et le refus
 * de `yes` sont sondes dans ssh-ui-flow.test.ts, qui parle au vrai terminal.
 *
 * Limite assumee : un `ssh` lance par `executeCommand` sans option garde `accept-new`, car
 * ce chemin n'a pas de tty pour poser la question ; OpenSSH sans tty echouerait par
 * « Host key verification failed. ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshConfig } from '@/network/protocols/ssh/SshConfig';
import { parseStrictHostKeyChecking } from '@/network/protocols/ssh/SshConnectOptions';
import { parseSshArgs } from '@/terminal/sessions/sshArgs';
import { buildLan, assignIps, PC2_IP, type SshLan } from './ssh-lan-fixtures';

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
  await lan.pc1.executeCommand('rm -f ~/.ssh/known_hosts');
});

const sshWith = (mode: string): Promise<string> =>
  lan.pc1.executeCommand(`ssh -o StrictHostKeyChecking=${mode} user@${PC2_IP} true`, 'admin\n');

describe('executeCommand : un hote inconnu', () => {
  it('TEMOIN -- accept-new connecte et enregistre la cle', async () => {
    expect(await sshWith('accept-new')).toBe('');
    expect(await lan.pc1.executeCommand('cat ~/.ssh/known_hosts')).toContain(PC2_IP);
  });

  it('TEMOIN -- no connecte', async () => {
    expect(await sshWith('no')).toBe('');
  });

  it('yes refuse, dans les mots d\'OpenSSH et sans la ligne DNS', async () => {
    expect(await sshWith('yes')).toBe(
      `No ED25519 host key is known for ${PC2_IP} and you have requested strict checking.\nHost key verification failed.`);
  });

  it('true vaut yes', async () => {
    expect(await sshWith('true')).toBe(await sshWith('yes'));
  });

  it('ask sans tty pour repondre echoue sur « Host key verification failed. »', async () => {
    expect(await sshWith('ask')).toBe('Host key verification failed.');
    expect(await lan.pc1.executeCommand('cat ~/.ssh/known_hosts')).not.toContain(PC2_IP);
  });

  it('TEMOIN -- sous yes, un hote deja connu passe', async () => {
    await sshWith('accept-new');
    expect(await sshWith('yes')).toBe('');
  });
});

describe('lecture du mot-cle', () => {
  it('ask n\'est plus lu comme yes', () => {
    expect(parseSshArgs(['-o', 'StrictHostKeyChecking=ask', 'user@h'])?.strict).toBe('ask');
    expect(parseSshArgs(['-o', 'StrictHostKeyChecking=yes', 'user@h'])?.strict).toBe('yes');
  });

  it('sans option le mode est non renseigne, pour que ~/.ssh/config puisse le fournir', () => {
    expect(parseSshArgs(['user@h'])?.strict).toBeUndefined();
  });

  it('true, false et off, de ~/.ssh/config comme de -o, sont normalises', () => {
    const entry = SshConfig.parse('Host a\n  StrictHostKeyChecking off\nHost b\n  StrictHostKeyChecking true\n');
    expect(entry.resolve('a').strictHostKeyChecking).toBe('no');
    expect(entry.resolve('b').strictHostKeyChecking).toBe('yes');
    expect(parseStrictHostKeyChecking('false')).toBe('no');
    expect(parseStrictHostKeyChecking('maybe')).toBeUndefined();
  });
});
