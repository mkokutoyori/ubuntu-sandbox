/**
 * Le journal de sshd annonce le port EPHEMERE du client, jamais le 22.
 *
 * Ecrit a l'aveugle depuis OpenSSH : `auth.c` l. 294 compose
 * « %s %s for %s%.100s from %.200s port %d ssh2 », et ce `%d` est le port
 * SOURCE du client — celui que `ss`/`netstat` montrent en face, pris dans
 * `/proc/sys/net/ipv4/ip_local_port_range`. Le 22 est le port du SERVEUR :
 * il n'apparait jamais a cette place.
 *
 * Ce que la machine faisait : DEUX emetteurs pour un meme fait. Une
 * connexion fait naitre l'evenement d'authentification a deux endroits —
 * `LinuxMachine.recordSshLogin`, qui connait le port du pair et le porte,
 * et `SshServerHandler`, qui ne connait que l'adresse. `SshSyslogger`
 * retombe alors sur SON port (`event.port ?? this.port`), c'est-a-dire 22.
 * Le journal montrait donc les deux valeurs pour une seule session :
 *
 *     Failed password for alice from 10.0.0.1 port 22 ssh2
 *     Accepted password for alice from 10.0.0.1 port 32768 ssh2
 *
 * La table des ports du pair existe deja et fait autorite ; le contexte
 * serveur l'expose maintenant, et le gestionnaire la lit au lieu de laisser
 * le journal deviner.
 *
 * Mesure avant correction : 2 cas tombent sur 3.
 * Le cas qui passe des deux cotes est le TEMOIN : la ligne `Accepted`
 * portait DEJA le bon port — c'est la reponse que l'autre emetteur doit
 * rejoindre, et sans lui une sonde faite de refus ne prouverait rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function labo(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);
  const m = new SubnetMask('255.255.255.0');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  return { pc, srv };
}

const OPT = '-o StrictHostKeyChecking=no';
const portsDe = (journal: string): number[] =>
  [...journal.matchAll(/ port (\d+) ssh2/g)].map(m => Number(m[1]));

describe('le port du journal est celui du client', () => {
  it('TEMOIN : la ligne `Accepted` porte deja un port ephemere', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const journal = String(await srv.executeCommand('journalctl -u ssh'));
    const acceptee = journal.split('\n').find(l => l.includes('Accepted password')) ?? '';
    const { min, max } = srv.getTcpStack().getEphemeralRange();
    const port = portsDe(acceptee)[0];
    expect(port).toBeGreaterThanOrEqual(min);
    expect(port).toBeLessThanOrEqual(max);
  });

  it('aucune ligne ssh2 n annonce le port 22 du serveur', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const journal = String(await srv.executeCommand('journalctl -u ssh'));
    const ports = portsDe(journal);
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p).not.toBe(22);
  });

  it('un echec et un succes du MEME pair citent le meme port', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`);
    const journal = String(await srv.executeCommand('journalctl -u ssh'));
    const ports = new Set(portsDe(journal));
    expect(ports.size).toBe(1);
  });
});
