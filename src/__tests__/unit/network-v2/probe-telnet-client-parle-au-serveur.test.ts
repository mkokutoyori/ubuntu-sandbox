/**
 * Sonde — le client `telnet` de Linux ne parlait a personne.
 *
 * Mesure AVANT, sur un cable entre un `LinuxPC` et un `LinuxServer` :
 *
 *   telnetd ARRETE, sans entree :  "telnet: connect to address
 *                                   10.0.0.20: Connection refused"
 *   telnetd ARRETE, AVEC entree :  "Connected to 10.0.0.20."
 *   telnetd DEMARRE, avec entree : "Connected to 10.0.0.20."
 *                                   (et rien d'autre : aucune invite)
 *
 * Deux faits dans ces trois lignes. Le premier : une porte FERMEE est
 * refusee ou acceptee selon que l'appelant a saisi quelque chose ou non
 * --
 *
 *   if (wireCapable && this.tcpProbe && !this.tcpProbe(found.ip, port)) {
 *     if (!stdinHas) { return ... Connection refused ... }
 *   }
 *
 * -- si bien que le verdict RESEAU depend de l'entree standard. Le
 * second : meme quand un telnetd ecoute pour de bon, le client ne lui
 * parle pas. Il interroge l'objet d'en face (`vtyAdmissionVerdict`,
 * `_getVtyLineConfig`), fabrique son entete, puis `emitTelnetWire`
 * SYNTHETISE la negociation IAC, une invite `login: ` et l'echo de
 * l'entree sur le bus de capture. Aucune trame ne traverse le cable.
 *
 * CINQ cas sur sept tombent avant la correction. Les deux autres sont
 * NOMMES :
 *
 *   - un nom qui ne se resout pas rend toujours `Name or service not
 *     known` : NON-REGRESSION, ce chemin-la ne depend pas du fil.
 *   - telnetd arrete et SANS entree refuse deja : TEMOIN. Il prouve que
 *     le refus existe et fonctionne, donc que le cas AVEC entree est bien
 *     une trappe et non une absence de verdict.
 *
 * Le cas le plus fort est le journal du SERVEUR : `LOGIN ON ... BY bob
 * FROM 10.0.0.10` ne peut etre ecrit que par la machine d'en face, et
 * seulement si la session l'a vraiment atteinte.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const SERVER_IP = '10.0.0.20';
const CLIENT_IP = '10.0.0.10';

async function buildLan(): Promise<{ client: LinuxPC; server: LinuxServer }> {
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  client.getPort('eth0')!.configureIP(new IPAddress(CLIENT_IP), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('cab').connect(client.getPort('eth0')!, server.getPort('eth0')!);
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('bob', { m: true, s: '/bin/bash' });
  um.setPassword('bob', 'bobsecret');
  return { client, server };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('le client telnet traverse vraiment le cable', () => {
  it('temoin : un telnetd arrete refuse quand rien n\'est saisi', async () => {
    const { client } = await buildLan();
    expect(await client.executeCommand(`telnet ${SERVER_IP}`)).toContain('Connection refused');
  });

  it('un telnetd arrete refuse AUSSI quand une entree est fournie', async () => {
    const { client } = await buildLan();
    const out = await client.executeCommand(`telnet ${SERVER_IP}`, 'bob\nbobsecret\nexit\n');
    expect(out).toContain('Connection refused');
    expect(out).not.toContain('Connected to');
  });

  it('non-regression : un nom qui ne se resout pas est toujours dit', async () => {
    const { client } = await buildLan();
    expect(await client.executeCommand('telnet zorglub.invalid', 'x\n'))
      .toContain('Name or service not known');
  });

  it('contre un telnetd vivant, le client voit l\'invite de connexion', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    const out = await client.executeCommand(`telnet ${SERVER_IP}`, 'bob\nbobsecret\nexit\n');
    expect(out).toMatch(/login: /);
  });

  it('le bon mot de passe rend la sortie de la commande distante', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    const out = await client.executeCommand(`telnet ${SERVER_IP}`, 'bob\nbobsecret\nwhoami\nexit\n');
    expect(out).toContain('bob');
  });

  it('un mauvais mot de passe rend `Login incorrect`', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    const out = await client.executeCommand(`telnet ${SERVER_IP}`, 'bob\nWRONG\nexit\n');
    expect(out).toContain('Login incorrect');
  });

  it('le SERVEUR inscrit la connexion dans son propre journal', async () => {
    const { client, server } = await buildLan();
    await server.executeCommand('systemctl start telnet');
    await client.executeCommand(`telnet ${SERVER_IP}`, 'bob\nbobsecret\nexit\n');
    const auth = await server.executeCommand('cat /var/log/auth.log');
    expect(auth).toMatch(new RegExp(`LOGIN ON \\S+ BY bob FROM ${CLIENT_IP.replace(/\./g, '\\.')}`));
  });
});
