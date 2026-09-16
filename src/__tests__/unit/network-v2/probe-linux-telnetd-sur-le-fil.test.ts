/**
 * Sonde — une machine Linux n'a pas de telnetd, et personne ne le disait.
 *
 * Mesure AVANT, sur `LinuxServer' :
 *
 *   systemctl start telnet     -> "Failed to start telnet.service:
 *                                  Unit telnet.service not found."
 *   systemctl is-active telnet -> "inactive"
 *   ss -tln                    -> :22 et :1521 ecoutent, JAMAIS :23
 *   isServiceActive('telnet')  -> false
 *
 * Il n'existe aucune unite `telnet' dans le catalogue de
 * `LinuxServiceManager', donc aucune ecoute sur le port 23, donc aucun
 * serveur a qui parler. `scenario-07-ssh-telnet-capture' tape pourtant
 * ce meme `systemctl start telnet' et sa session telnet reussit : elle
 * reussit parce que le CLIENT de `LinuxCommandExecutor' repond de
 * lui-meme et synthetise la conversation sur le bus de capture, sans
 * qu'une seule trame traverse le cable.
 *
 * SEPT cas sur neuf tombent avant la correction. Les deux autres sont
 * NOMMES, avec leur raison :
 *
 *   - sshd ecoute sur :22 dans le meme laboratoire : TEMOIN. Il prouve
 *     que la machinerie d'unites et d'ecoutes fonctionne, donc qu'un
 *     `:23' absent est une absence de telnetd et non un laboratoire
 *     casse.
 *   - demarrer telnet ne touche pas a :22 : NON-REGRESSION.
 *
 * Autorite pour les mots du serveur : util-linux `login-utils/login.c',
 * que telnetd exec. L'invite est `"<host> login: "' puis `"Password: "',
 * `LOGIN_MAX_TRIES' vaut 3, et un echec rend `"Login incorrect"'.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { TelnetClientSession } from '@/network/protocols/telnet/TelnetClientSession';
import type { TelnetClientTransport } from '@/network/protocols/telnet/TelnetClientSession';

const MASK = new SubnetMask('255.255.255.0');
const SERVER_IP = '10.0.0.20';

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildLan(): Promise<{ client: LinuxPC; server: LinuxServer }> {
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  client.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('cab').connect(client.getPort('eth0')!, server.getPort('eth0')!);
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alicesecret');
  return { client, server };
}

async function openTelnet(client: LinuxPC): Promise<TelnetClientSession | null> {
  const socket = await (client as unknown as {
    tcpConnect(h: string, p: number): Promise<TelnetClientTransport | null>;
  }).tcpConnect(SERVER_IP, 23);
  return socket ? new TelnetClientSession(socket) : null;
}

async function login(session: TelnetClientSession, password: string): Promise<string> {
  await settle();
  session.drain();
  session.send('alice');
  await settle();
  session.send(password);
  await settle();
  return session.drain();
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('un telnetd Linux ecoute vraiment le port 23', () => {
  it('l\'unite telnet existe', async () => {
    const { server } = await buildLan();
    expect(await server.executeCommand('systemctl start telnet')).not.toContain('could not be found');
    expect(await server.executeCommand('systemctl start telnet')).not.toContain('not found');
  });

  it('une fois demarree, l\'unite est active', async () => {
    const { server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    expect((await server.executeCommand('systemctl is-active telnet')).trim()).toBe('active');
  });

  it('une fois demarree, le port 23 ecoute', async () => {
    const { server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    expect(await server.executeCommand('ss -tln')).toMatch(/0\.0\.0\.0:23\s/);
  });

  it('temoin : sshd ecoute sur 22 dans le meme laboratoire', async () => {
    const { server } = await buildLan();
    expect(await server.executeCommand('ss -tln')).toMatch(/0\.0\.0\.0:22\s/);
  });

  it('non-regression : demarrer telnet ne ferme pas :22', async () => {
    const { server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    expect(await server.executeCommand('ss -tln')).toMatch(/0\.0\.0\.0:22\s/);
  });

  it('un client telnet reel atteint l\'invite de connexion', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    const session = await openTelnet(client);
    expect(session).not.toBeNull();
    await settle();
    expect(session!.drain()).toMatch(/login: /);
  });

  it('le bon mot de passe ouvre une session qui execute une commande', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    const session = await openTelnet(client);
    expect(session).not.toBeNull();
    await login(session!, 'alicesecret');
    session!.drain();
    session!.send('whoami');
    await settle();
    expect(session!.drain()).toContain('alice');
  });

  it('un mauvais mot de passe rend `Login incorrect`', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    const session = await openTelnet(client);
    expect(session).not.toBeNull();
    expect(await login(session!, 'WRONG')).toContain('Login incorrect');
  });

  it('`systemctl stop telnet` referme le port 23', async () => {
    const { server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    expect(await server.executeCommand('ss -tln')).toMatch(/0\.0\.0\.0:23\s/);
    await server.executeCommand('systemctl stop telnet');
    expect(await server.executeCommand('ss -tln')).not.toMatch(/0\.0\.0\.0:23\s/);
  });
});
