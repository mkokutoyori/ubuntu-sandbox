/**
 * Sonde — le client telnet de Windows composait puis raccrochait.
 *
 * Mesure AVANT, depuis un `WindowsPC` vers un `LinuxServer` dont le
 * telnetd ecoute :
 *
 *   telnet 10.0.0.20 -> "Connecting To 10.0.0.20...
 *                        Welcome to Microsoft Telnet Client
 *                        Escape Character is 'CTRL+]'"
 *
 * et rien d'autre, quelle que soit l'entree fournie. `cmdTelnet' ouvre
 * bien une VRAIE connexion TCP -- `await this.tcpConnect(host, port)' --
 * puis appelle `sock.close()' immediatement et rend une banniere figee.
 * La connexion prouve donc que le port repond, et s'arrete la : aucune
 * negociation, aucune invite, aucune session. Le serveur d'en face
 * n'inscrit rien, parce que rien ne lui a ete demande.
 *
 * QUATRE cas sur six tombent avant la correction. Les deux autres sont
 * NOMMES :
 *
 *   - un port ferme rend toujours "Could not open connection" :
 *     NON-REGRESSION, ce chemin passait deja par le fil.
 *   - `telnet' sans argument rend toujours l'aide de `Microsoft Telnet>' :
 *     NON-REGRESSION, il ne touche pas au reseau.
 *
 * Le cas decisif est, ici aussi, le journal du SERVEUR : un
 * `LOGIN ON ... BY bob FROM 10.0.0.10` ne peut etre ecrit que par la
 * machine d'en face, et seulement si la session l'a vraiment atteinte.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const SERVER_IP = '10.0.0.20';
const CLIENT_IP = '10.0.0.10';

async function buildLan(startTelnetd = true): Promise<{ win: WindowsPC; server: LinuxServer }> {
  const win = new WindowsPC('windows-pc', 'WIN1');
  const server = new LinuxServer('linux-server', 'SERVER');
  win.getPorts()[0].configureIP(new IPAddress(CLIENT_IP), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('cab').connect(win.getPorts()[0], server.getPort('eth0')!);
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('bob', { m: true, s: '/bin/bash' });
  um.setPassword('bob', 'bobsecret');
  if (startTelnetd) await server.executeCommand('systemctl start telnet');
  return { win, server };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('le client telnet de Windows tient une vraie session', () => {
  it('non-regression : un port ferme est toujours dit', async () => {
    const { win } = await buildLan(false);
    expect(await win.executeCommand(`telnet ${SERVER_IP}`))
      .toContain('Could not open connection');
  });

  it('non-regression : sans argument, l\'aide de Microsoft Telnet reste', async () => {
    const { win } = await buildLan();
    expect(await win.executeCommand('telnet')).toContain('Microsoft Telnet>');
  });

  it('contre un telnetd vivant, le client voit l\'invite de connexion', async () => {
    const { win } = await buildLan();
    const out = await win.executeCommand(`telnet ${SERVER_IP}`, 'bob\nbobsecret\nexit\n');
    expect(out).toMatch(/login: /);
  });

  it('le bon mot de passe rend la sortie de la commande distante', async () => {
    const { win } = await buildLan();
    const out = await win.executeCommand(`telnet ${SERVER_IP}`, 'bob\nbobsecret\nwhoami\nexit\n');
    expect(out).toContain('bob');
  });

  it('un mauvais mot de passe rend `Login incorrect`', async () => {
    const { win } = await buildLan();
    const out = await win.executeCommand(`telnet ${SERVER_IP}`, 'bob\nWRONG\nexit\n');
    expect(out).toContain('Login incorrect');
  });

  it('le SERVEUR inscrit la connexion dans son propre journal', async () => {
    const { win, server } = await buildLan();
    await win.executeCommand(`telnet ${SERVER_IP}`, 'bob\nbobsecret\nexit\n');
    const auth = await server.executeCommand('cat /var/log/auth.log');
    expect(auth).toMatch(new RegExp(`LOGIN ON \\S+ BY bob FROM ${CLIENT_IP.replace(/\./g, '\\.')}`));
  });
});
