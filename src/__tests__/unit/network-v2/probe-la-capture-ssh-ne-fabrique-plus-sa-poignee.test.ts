/**
 * Une session SSH reelle recevait une SECONDE poignee de main, fabriquee.
 *
 * MESURE DE DEPART sur `3104e0a8'. Un client Linux cable a un serveur,
 * capture lancee AVANT le trafic (`tcpdump -w' detache), puis relue :
 *
 *   10:44:05.375 IP 10.0.0.1.32769 > 10.0.0.2.22: Flags [S], seq 475792681,
 *                win 65535, options [mss 1460,sackOK,TS val 19910 ecr 0,wscale 7]
 *   ... bannieres, authentification, exec, 25 segments en tout ...
 *   10:44:05.419 IP 10.0.0.1.32769 > 10.0.0.2.22: Flags [S], seq 0, win 0
 *   10:44:05.420 IP 10.0.0.2.22 > 10.0.0.1.32769: Flags [S.], seq 0, ack 1, win 0
 *   10:44:05.421 IP 10.0.0.1.32769 > 10.0.0.2.22: Flags [.], seq 1, ack 1, win 0
 *   10:44:05.422 IP 10.0.0.1.32769 > 10.0.0.2.22: Flags [F.], seq 475793018 ...
 *
 * Une poignee de main COMPLETE, seq 0 et fenetre 0, sans options, sur un
 * quadruplet etabli depuis 44 ms et arrive a seq 475793018 — glissee entre
 * l'exec et le FIN. Le fil portait deja la vraie ; `mirrorSshHandshakeCapture'
 * en ecrivait une seconde dans les deux journaux de capture. Un meme fait
 * ecrit deux fois, et la copie fabriquee contredit les trames reelles qui
 * l'entourent.
 *
 * Meme chose cote serveur : `openSshSessionRecord' appelait
 * `captureTcpHandshake' pour CHAQUE session acceptee, alors que le tap du
 * port avait deja enregistre la vraie.
 *
 * Et le port cite : `sshClientPort' INVENTAIT un ephemere a partir de son
 * propre compteur au lieu de lire celui du socket accepte. Le journal
 * annoncait « port 32768 » quand le fil montrait 32769 — deux vues de la
 * meme session, en desaccord.
 *
 * AUTORITE. Pas de RFC a citer ici : ce que la sonde oppose, c'est la
 * machine a elle-meme. Le tap de `Port' est le seul ecrivain legitime de
 * ce qui a traverse un cable (CLAUDE.md, regle 4), et `socket.remotePort'
 * du socket accepte est le seul port source qui existe. La reference est
 * donc la capture elle-meme, relue apres coup.
 *
 * MESURE : 5 cas tombent sur 8 (`git stash' sur LinuxMachine.ts et
 * LinuxCommandExecutor.ts). Les trois cas qui passent des deux cotes :
 *   - TEMOIN : la vraie poignee de main, avec MSS/SACK/TS, est bien sur le
 *     fil — sans lui une sonde faite de refus ne prouverait rien ;
 *   - TEMOIN : le journal cite deja un port EPHEMERE, jamais le 22 ;
 *   - NON-REGRESSION : `whoami' distant repond toujours le bon utilisateur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const OPT = '-o StrictHostKeyChecking=no';

async function labo(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1', 0, 0);
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

interface Segment { src: string; sport: number; dst: string; dport: number; flags: string; options: boolean; win: number }

function segments(capture: string): Segment[] {
  const out: Segment[] = [];
  const re = /IP (\d+\.\d+\.\d+\.\d+)\.(\d+) > (\d+\.\d+\.\d+\.\d+)\.(\d+): Flags \[([^\]]*)\][^\n]*?win (\d+)([^\n]*)/g;
  for (const m of capture.matchAll(re)) {
    out.push({
      src: m[1], sport: Number(m[2]), dst: m[3], dport: Number(m[4]),
      flags: m[5], win: Number(m[6]), options: m[7].includes('options ['),
    });
  }
  return out;
}

const synsFrom = (segs: Segment[], sport: number): Segment[] =>
  segs.filter(s => s.sport === sport && s.dport === 22 && s.flags === 'S');

async function sessionCapture(): Promise<{ pc: LinuxPC; srv: LinuxServer; clientSide: Segment[]; serverSide: Segment[]; journal: string }> {
  const { pc, srv } = await labo();
  await pc.executeCommand('tcpdump -ni eth0 port 22 -w /tmp/client.pcap &');
  await srv.executeCommand('tcpdump -ni eth0 port 22 -w /tmp/server.pcap &');
  await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`, 'secret123\n');
  const clientSide = segments(String(await pc.executeCommand('tcpdump -nn -r /tmp/client.pcap')));
  const serverSide = segments(String(await srv.executeCommand('tcpdump -nn -r /tmp/server.pcap')));
  const journal = String(await srv.executeCommand('cat /var/log/auth.log'));
  return { pc, srv, clientSide, serverSide, journal };
}

function sessionPort(segs: Segment[]): number {
  const carried = segs.find(s => s.dport === 22 && s.flags === 'P.');
  return carried?.sport ?? -1;
}

describe('la capture d une session SSH reelle ne porte qu une poignee de main', () => {
  it('TEMOIN : la vraie poignee de main est sur le fil, avec ses options', async () => {
    const { clientSide } = await sessionCapture();
    const port = sessionPort(clientSide);
    expect(port).toBeGreaterThan(0);
    const syns = synsFrom(clientSide, port);
    expect(syns.length).toBeGreaterThan(0);
    expect(syns.some(s => s.options && s.win > 0)).toBe(true);
  });

  it('le client ne voit QU UN SYN pour la session', async () => {
    const { clientSide } = await sessionCapture();
    expect(synsFrom(clientSide, sessionPort(clientSide)).length).toBe(1);
  });

  it('le serveur ne voit QU UN SYN pour la session', async () => {
    const { serverSide } = await sessionCapture();
    expect(synsFrom(serverSide, sessionPort(serverSide)).length).toBe(1);
  });

  it('aucun SYN ne survient APRES un segment de donnees de la meme session', async () => {
    const { clientSide } = await sessionCapture();
    const port = sessionPort(clientSide);
    const mine = clientSide.filter(s => s.sport === port || s.dport === port);
    const firstData = mine.findIndex(s => s.flags === 'P.');
    expect(firstData).toBeGreaterThanOrEqual(0);
    expect(mine.slice(firstData).some(s => s.flags === 'S' || s.flags === 'S.')).toBe(false);
  });

  it('aucun segment de la session n annonce une fenetre nulle', async () => {
    const { clientSide } = await sessionCapture();
    const port = sessionPort(clientSide);
    const mine = clientSide.filter(s => s.sport === port || s.dport === port);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter(s => s.win === 0)).toEqual([]);
  });

  it('TEMOIN : le journal cite un port ephemere, jamais le 22', async () => {
    const { srv, journal } = await sessionCapture();
    const ports = [...journal.matchAll(/ port (\d+) ssh2/g)].map(m => Number(m[1]));
    expect(ports.length).toBeGreaterThan(0);
    const { min, max } = srv.getTcpStack().getEphemeralRange();
    for (const p of ports) {
      expect(p).not.toBe(22);
      expect(p).toBeGreaterThanOrEqual(min);
      expect(p).toBeLessThanOrEqual(max);
    }
  });

  it('le port cite par le journal est celui que la capture montre', async () => {
    const { clientSide, journal } = await sessionCapture();
    const port = sessionPort(clientSide);
    const ports = [...journal.matchAll(/ port (\d+) ssh2/g)].map(m => Number(m[1]));
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p).toBe(port);
  });

  it('NON-REGRESSION : le whoami distant repond toujours alice', async () => {
    const { pc } = await labo();
    const out = String(await pc.executeCommand(`ssh ${OPT} alice@10.0.0.2 whoami`, 'secret123\n'));
    expect(out).toMatch(/^alice\s*$/m);
  });
});
