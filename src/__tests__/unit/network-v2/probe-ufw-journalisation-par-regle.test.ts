/**
 * `ufw allow log 22/tcp` et `log-all` : la journalisation PAR REGLE de ufw 0.36.1 (src/backend_iptables.py `_get_rules_from_formatted`,
 * `get_status`, tests/good/logging/result). Mesure de depart : le mot `log` n'etait pas reconnu (« invalid rule syntax »).
 *
 * Ce que la source fixe : la regle devient trois lignes dans la chaine utilisateur -- dans `ufw-user-logging-input`, un LOG limite a
 * 3/min en rafale de 10 avec le prefixe `[UFW ALLOW] ` (ou `[UFW BLOCK] `), restreint aux NOUVELLES connexions pour `log` mais pas
 * pour `log-all`, puis un RETURN ; dans `ufw-user-input`, le saut vers la chaine de journalisation, puis l'action. `status` ajoute
 * `(log)` ou `(log-all)` apres la colonne From.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

let srv: LinuxServer;

const row = (to: string, action: string, from: string, tail = ''): string => `${to.padEnd(26)} ${action.padEnd(12)}${from.padEnd(26)}${tail}`;

beforeEach(async () => {
  srv = new LinuxServer('linux-server', 'srv', 0, 0);
  srv.powerOn();
  await srv.executeCommand('ufw enable');
});

describe('log', () => {
  it('la regle est acceptee', async () => {
    expect(await srv.executeCommand('ufw allow log 22/tcp')).toContain('Rule added');
  });

  it('status ajoute (log) apres From', async () => {
    await srv.executeCommand('ufw allow log 22/tcp');
    expect((await srv.executeCommand('ufw status')).split('\n')[4]).toBe(row('22/tcp', 'ALLOW', 'Anywhere', ' (log)'));
  });

  it('la chaine de journalisation porte le LOG limite, restreint aux nouvelles connexions', async () => {
    await srv.executeCommand('ufw allow log 22/tcp');
    const out = await srv.executeCommand('iptables -S ufw-user-logging-input');
    expect(out).toContain('-A ufw-user-logging-input -p tcp -m tcp --dport 22 -m conntrack --ctstate NEW -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW ALLOW] "');
    expect(out).toContain('-A ufw-user-logging-input -p tcp -m tcp --dport 22 -j RETURN');
  });

  it('la chaine utilisateur saute vers elle AVANT l\'action', async () => {
    await srv.executeCommand('ufw allow log 22/tcp');
    const lines = (await srv.executeCommand('iptables -S ufw-user-input')).split('\n');
    const jump = lines.indexOf('-A ufw-user-input -p tcp -m tcp --dport 22 -j ufw-user-logging-input');
    const accept = lines.indexOf('-A ufw-user-input -p tcp -m tcp --dport 22 -j ACCEPT');
    expect(jump).toBeGreaterThan(-1);
    expect(accept).toBe(jump + 1);
  });

  it('show added rejoue le mot log', async () => {
    await srv.executeCommand('ufw allow log 22/tcp');
    expect(await srv.executeCommand('ufw show added')).toContain('ufw allow log 22/tcp');
  });
});

describe('log-all', () => {
  it('journalise tous les paquets : pas de restriction aux nouvelles connexions, prefixe BLOCK pour un refus', async () => {
    await srv.executeCommand('ufw deny log-all 23/tcp');
    const out = await srv.executeCommand('iptables -S ufw-user-logging-input');
    expect(out).toContain('-A ufw-user-logging-input -p tcp -m tcp --dport 23 -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW BLOCK] "');
    expect(out).not.toContain('--ctstate NEW');
  });

  it('status ecrit (log-all)', async () => {
    await srv.executeCommand('ufw deny log-all 23/tcp');
    expect((await srv.executeCommand('ufw status')).split('\n')[4]).toContain('(log-all)');
  });
});

describe('mise a jour', () => {
  it('la meme regle sans log, puis avec log, est une mise a jour', async () => {
    await srv.executeCommand('ufw allow 22/tcp');
    expect(await srv.executeCommand('ufw allow log 22/tcp')).toContain('Rule updated');
  });

  it('TEMOIN : la meme regle redite a l\'identique reste « Skipping adding existing rule »', async () => {
    await srv.executeCommand('ufw allow log 22/tcp');
    expect(await srv.executeCommand('ufw allow log 22/tcp')).toContain('Skipping adding existing rule');
  });
});

describe('user.rules', () => {
  it('la journalisation survit a un rechargement depuis le fichier', async () => {
    await srv.executeCommand('ufw allow log 22/tcp');
    await srv.executeCommand('ufw deny log-all 23/tcp');
    await srv.executeCommand('ufw reload');
    const status = await srv.executeCommand('ufw status');
    expect(status).toMatch(/^22\/tcp +ALLOW +Anywhere +\(log\)/m);
    expect(status).toMatch(/^23\/tcp +DENY +Anywhere +\(log-all\)/m);
  });
});
