/*
 * Sonde — `telnet` dont l'entrée est un tube parle comme le client netkit enregistré, pas comme une copie.
 *
 * Mesure AVANT, sur un LinuxPC qui tape `printf ... | telnet 10.0.0.20` : le client de `LinuxCommandExecutor` répondait de son côté,
 * fermait la session lui-même après la dernière ligne et rendait 0 ; le vrai binaire (telnet-client-netkit-oracle.test.ts, famille
 * « pipes ») rend `Connection closed by foreign host.` et le code 1 dès que l'entrée est épuisée, écrit ses erreurs sur stderr avant
 * le texte bufferisé de stdout, n'envoie ni NAWS ni vitesse réelle sans terminal, et prend `\n` pour `\r\n` en mode ligne.
 *
 * CINQ cas sur huit tombent avant le remplacement. Les trois autres sont NOMMÉS : le témoin (le serveur répond sur :23, donc un échec
 * ailleurs est celui du client), `rend le code 1 quand la connexion se ferme` (l'ancien client rendait déjà 1, mais parce que le tube
 * arrivait en dernier argument et faisait échouer la résolution — le même nombre pour une autre raison) et la non-régression (un
 * `telnet` vers un port fermé rend toujours un code non nul).
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

async function buildLan(): Promise<{ pc: LinuxPC; server: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SERVER');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), MASK);
  new Cable('cab').connect(pc.getPort('eth0')!, server.getPort('eth0')!);
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alicesecret');
  await server.executeCommand('systemctl start telnet');
  return { pc, server };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('telnet avec un tube sur l\'entrée standard', () => {
  it('témoin : le serveur répond sur :23', async () => {
    const { server } = await buildLan();
    expect(await server.executeCommand('ss -tln')).toMatch(/0\.0\.0\.0:23\s/);
  });

  it('affiche l\'en-tête de connexion de netkit', async () => {
    const { pc } = await buildLan();
    const out = await pc.executeCommand(`printf 'alice\\n' | telnet ${SERVER_IP}`);
    expect(out).toContain(`Trying ${SERVER_IP}...`);
    expect(out).toContain(`Connected to ${SERVER_IP}.`);
    expect(out).toContain("Escape character is '^]'.");
  });

  it('rend le texte du serveur, invite de connexion comprise', async () => {
    const { pc } = await buildLan();
    const out = await pc.executeCommand(`printf 'alice\\n' | telnet ${SERVER_IP}`);
    expect(out).toMatch(/login: /);
  });

  it('une entrée épuisée ferme la connexion comme le fait netkit', async () => {
    const { pc } = await buildLan();
    const out = await pc.executeCommand(`printf 'alice\\n' | telnet ${SERVER_IP}`);
    expect(out).toContain('Connection closed by foreign host.');
  });

  it('rend le code 1 quand la connexion se ferme', async () => {
    const { pc } = await buildLan();
    await pc.executeCommand(`printf 'alice\\n' | telnet ${SERVER_IP}`);
    expect((await pc.executeCommand('echo $?')).trim()).toBe('1');
  });

  it('un port fermé se dit avec les mots de netkit', async () => {
    const { pc } = await buildLan();
    const out = await pc.executeCommand(`telnet ${SERVER_IP} 1 </dev/null`);
    expect(out).toContain('telnet: Unable to connect to remote host: Connection refused');
  });

  it('non-régression : un port fermé rend un code non nul', async () => {
    const { pc } = await buildLan();
    await pc.executeCommand(`telnet ${SERVER_IP} 1 </dev/null`);
    expect((await pc.executeCommand('echo $?')).trim()).not.toBe('0');
  });

  it('une option inconnue affiche le usage de netkit', async () => {
    const { pc } = await buildLan();
    const out = await pc.executeCommand('telnet -z');
    expect(out).toContain("telnet: invalid option -- 'z'");
    expect(out).toContain('Usage: telnet [-4] [-6] [-8] [-E] [-L] [-a] [-d] [-e char] [-l user]');
  });
});
