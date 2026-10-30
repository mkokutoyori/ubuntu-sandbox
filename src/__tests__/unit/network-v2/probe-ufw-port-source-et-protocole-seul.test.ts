/**
 * `ufw allow from A port P to B port Q proto X` : le port SOURCE et le protocole sans port sont des criteres que ufw 0.36.1 ecrit
 * (src/parser.py `UFWParserRule`, src/frontend.py, src/backend_iptables.py `get_status`), et que le simulateur jetait.
 *
 * Mesure de depart : `from 10.0.0.1 port 1024 to any port 22 proto tcp` rangeait 1024 comme port de DESTINATION et perdait 22 ;
 * `deny proto udp from any to 10.0.0.5` perdait `udp` et jetait donc TOUT le trafic vers 10.0.0.5 -- une regle plus large que son texte.
 *
 * Ce que la source fixe : la ligne de `status` est `dst[ port][/proto]` a gauche et `src[ port][/proto]` a droite ; sans port, le
 * protocole suit l'adresse quand les deux ports sont « any » (`10.0.0.5/udp`) ; `ufw show added` rejoue la regle avec `port` apres chaque
 * adresse ; deux regles qui different par le port source sont deux regles.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

let srv: LinuxServer;

const row = (to: string, action: string, from: string): string => `${to.padEnd(26)} ${action.padEnd(12)}${from.padEnd(26)}`;

beforeEach(async () => {
  srv = new LinuxServer('linux-server', 'srv', 0, 0);
  srv.powerOn();
  await srv.executeCommand('ufw enable');
});

describe('port source', () => {
  const RULE = 'ufw allow from 10.0.0.1 port 1024 to any port 22 proto tcp';

  it('status : le port source suit l\'adresse source, avec son protocole', async () => {
    await srv.executeCommand(RULE);
    expect((await srv.executeCommand('ufw status')).split('\n')[4]).toBe(row('22/tcp', 'ALLOW', '10.0.0.1 1024/tcp'));
  });

  it('le noyau recoit --sport ET --dport', async () => {
    await srv.executeCommand(RULE);
    expect(await srv.executeCommand('iptables -S ufw-user-input'))
      .toContain('-A ufw-user-input -s 10.0.0.1/32 -p tcp -m tcp --sport 1024 --dport 22 -j ACCEPT');
  });

  it('show added rejoue la regle telle qu\'ecrite', async () => {
    await srv.executeCommand(RULE);
    expect(await srv.executeCommand('ufw show added')).toContain(RULE);
  });

  it('deux regles qui different par le port source sont deux regles', async () => {
    await srv.executeCommand(RULE);
    expect(await srv.executeCommand('ufw allow from 10.0.0.1 port 2048 to any port 22 proto tcp')).toContain('Rule added');
    expect(await srv.executeCommand(RULE)).toContain('Skipping adding existing rule');
  });

  it('delete retrouve la regle par son port source', async () => {
    await srv.executeCommand(RULE);
    expect(await srv.executeCommand(`ufw delete ${RULE.slice(4)}`)).toContain('Rule deleted');
  });

  it('TEMOIN : sans port source, la regle garde son ancien texte', async () => {
    await srv.executeCommand('ufw allow from 10.0.0.1 to any port 22 proto tcp');
    expect((await srv.executeCommand('ufw status')).split('\n')[4]).toBe(row('22/tcp', 'ALLOW', '10.0.0.1'));
  });
});

describe('protocole sans port', () => {
  it('status : le protocole suit l\'adresse', async () => {
    await srv.executeCommand('ufw deny proto udp from any to 10.0.0.5');
    expect((await srv.executeCommand('ufw status')).split('\n')[4]).toBe(row('10.0.0.5/udp', 'DENY', 'Anywhere'));
  });

  it('le noyau ne jette que l\'UDP', async () => {
    await srv.executeCommand('ufw deny proto udp from any to 10.0.0.5');
    expect(await srv.executeCommand('iptables -S ufw-user-input')).toContain('-A ufw-user-input -d 10.0.0.5/32 -p udp -j DROP');
  });

  it('show added garde le protocole', async () => {
    await srv.executeCommand('ufw deny proto udp from any to 10.0.0.5');
    expect(await srv.executeCommand('ufw show added')).toContain('ufw deny from any to 10.0.0.5 proto udp');
  });
});
