/**
 * Le journal de connexion du serveur SMTP. Mesure de depart : une session SMTP complete contre un LinuxServer (enableSmtpService) n'ecrivait rien dans le syslog : ni `connect from`
 * ni `disconnect from`, alors que Postfix smtpd les ecrit a chaque connexion (src/smtpd/smtpd.c lignes 6487 et 6536 du depot vdukhovni/postfix, facility mail, etiquette `postfix/smtpd`).
 * Ce que la source fixe : `connect from nom[adresse]` (`unknown[adresse]` quand l'adresse n'a pas de nom inverse) ; `disconnect from nom[adresse]` suivi, en minuscules, des compteurs
 * de commandes dans l'ordre de smtpd_cmd_table (helo ehlo xclient xforward starttls auth mail rcpt data bdat rset noop vrfy etrn quit help puis unknown), `nom=reussies` ou
 * `nom=reussies/total` quand une commande a ete refusee, puis `commands=reussies` (ou `commands=reussies/total` si l'une a echoue, ou `commands=0/0` si rien n'a ete recu)
 * (smtpd_format_cmd_stats, lignes 6340 a 6390). Une commande est reussie quand sa reponse est 2xx ou 3xx ; un DATA dont le corps est refuse n'est pas compte reussi.
 * Reserves (TODO.md) : une deconnexion sans QUIT n'est pas observee (le socket ne notifie pas sa fermeture), donc `lost connection after` n'est jamais ecrit ; les autres lignes de
 * Postfix (client=, message-id=, queue id) ne sont pas ecrites.
 *
 * Discrimine par `git stash` sur src/network : tous les cas tombent avant sauf le TEMOIN, qui prouve que la session elle-meme aboutit (reponse 250 de bout en bout).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import { SMTP_SUBMISSION_PORT } from '@/network/smtp/SmtpServer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

function lab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  srv.enableSmtpService();
  const mailLog = async (): Promise<string> => {
    const machine = srv as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } };
    return String(await machine.executor.runAsUser('root', () => srv.executeCommand('journalctl -t postfix/smtpd --no-pager'))).trim();
  };
  return { pc, srv, mailLog };
}

const connect = (pc: LinuxPC, port?: number) => {
  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', port);
  client.connect();
  return client;
};

describe('a full transaction', () => {
  it('WITNESS — the transaction itself succeeds', () => {
    const { pc } = lab();
    const client = connect(pc);
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    expect(client.sendDataBody('Subject: hi\r\n\r\nBody')?.code).toBe(250);
  });

  it('logs connect and disconnect with the command counters of smtpd_format_cmd_stats', async () => {
    const { pc, mailLog } = lab();
    const client = connect(pc);
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'DATA' });
    client.sendDataBody('Subject: hi\r\n\r\nBody');
    client.sendCommand({ verb: 'QUIT' });
    const log = await mailLog();
    expect(log).toMatch(/postfix\/smtpd\[\d+\]: connect from unknown\[10\.0\.1\.2\]$/m);
    expect(log).toMatch(/postfix\/smtpd\[\d+\]: disconnect from unknown\[10\.0\.1\.2\] ehlo=1 mail=1 rcpt=1 data=1 quit=1 commands=5$/m);
  });
});

describe('refused commands', () => {
  it('shows success/total for a command that failed and for unknown ones', async () => {
    const { pc, mailLog } = lab();
    const client = connect(pc);
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    client.sendCommand({ verb: 'ZORGLUB' });
    client.sendCommand({ verb: 'QUIT' });
    expect(await mailLog()).toMatch(/disconnect from unknown\[10\.0\.1\.2\] ehlo=1 rcpt=0\/1 quit=1 unknown=0\/1 commands=2\/4$/m);
  });

  it('a submission client refused before AUTH counts mail=0/1', async () => {
    const { pc, mailLog } = lab();
    const client = connect(pc, SMTP_SUBMISSION_PORT);
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    client.sendCommand({ verb: 'QUIT' });
    expect(await mailLog()).toMatch(/disconnect from unknown\[10\.0\.1\.2\] ehlo=1 mail=0\/1 quit=1 commands=2\/3$/m);
  });
});

describe('the peer name', () => {
  it('uses the reverse name when /etc/hosts gives one', async () => {
    const { pc, srv, mailLog } = lab();
    await (srv as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } })
      .executor.runAsUser('root', () => srv.executeCommand(`sh -c 'echo "10.0.1.2 client.example.org" >> /etc/hosts'`));
    const client = connect(pc);
    client.sendCommand({ verb: 'QUIT' });
    expect(await mailLog()).toMatch(/connect from client\.example\.org\[10\.0\.1\.2\]$/m);
  });
});
