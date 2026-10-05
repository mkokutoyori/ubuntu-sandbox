/*
 * `ssh-keyscan` ecrit toutes les bannieres `# hote:port ...` AVANT les cles.
 *
 * Mesure de depart : `ssh-keyscan 10.0.0.2` rendait la ligne de cle d'abord,
 * puis cinq lignes `# 10.0.0.2:22 SSH-2.0-OpenSSH_8.9p1 Ubuntu-...` — la
 * sortie standard puis l'erreur standard, concatenees. Sur le terminal Linux
 * le meme ordre : la derniere ligne etait une banniere, pas une cle. Trois
 * tests qui lisaient « le dernier champ » de la sortie pour y trouver la cle
 * en etaient rouges.
 *
 * L'AUTORITE — le comportement d'ssh-keyscan d'OpenSSH 8.9, LU DE MEMOIRE
 * (la source n'est pas atteignable d'ici) : une connexion non bloquante par
 * type de cle (rsa, ecdsa, ed25519, ecdsa-sk, ed25519-sk par defaut), toutes
 * ouvertes avant que la moindre echange de cles ne s'acheve ; chacune ecrit sa
 * banniere (sortie d'ERREUR) a la reception de l'identification du serveur, et
 * sa cle (sortie standard) quand l'echange est fini. Les bannieres precedent
 * donc les cles, comme on le voit sur un `ssh-keyscan github.com` reel. Le
 * nombre de connexions simultanees est borne par la limite de descripteurs
 * (MAXMAXFD 256 dans la source, de memoire) : au-dela, une vague de
 * bannieres puis ses cles, puis la vague suivante. Le simulateur prend 256.
 * Sur le terminal, les deux flux sont rendus dans l'ordre ou ils sont
 * ecrits ; `2>/dev/null` ne garde que les cles.
 *
 * Ecrite a l'aveugle. 6 des 7 cas tombent avant (git stash push -- src/network).
 * Le seul qui passe des deux cotes est un TEMOIN : `2>/dev/null` — la
 * separation des deux flux ne change pas, et la sonde prouve que le labo
 * produit bien une cle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { runSshKeyscanCommand, type SshKeyscanHost } from '@/network/protocols/ssh/SshKeyscanCommand';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(): Promise<{ pc: LinuxPC; win: WindowsPC }> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  [pc, win, srv].forEach((device, index) => {
    device.powerOn();
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
  });
  const mask = new SubnetMask('255.255.255.0');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  await srv.executeCommand('sudo systemctl start ssh');
  return { pc, win };
}

const isBanner = (line: string): boolean => line.startsWith('# 10.0.0.2:22 SSH-2.0-');
const isKey = (line: string): boolean => line.startsWith('10.0.0.2 ssh-ed25519 ');

describe('on the Linux terminal', () => {
  it('writes the five banners, then the key', async () => {
    const { pc } = await lab();
    const lines = (await pc.executeCommand('ssh-keyscan 10.0.0.2')).split('\n');

    expect(lines.filter(isBanner)).toHaveLength(5);
    expect(lines.slice(0, 5).every(isBanner)).toBe(true);
    expect(isKey(lines[5])).toBe(true);
  });

  it('ends on a key line', async () => {
    const { pc } = await lab();
    const lines = (await pc.executeCommand('ssh-keyscan 10.0.0.2')).split('\n');

    expect(isKey(lines[lines.length - 1])).toBe(true);
  });

  it('keeps only the key lines when the error stream is discarded', async () => {
    const { pc } = await lab();
    const lines = (await pc.executeCommand('ssh-keyscan 10.0.0.2 2>/dev/null')).split('\n');

    expect(lines).toHaveLength(1);
    expect(isKey(lines[0])).toBe(true);
  });

  it('writes one banner then one key for a single key type', async () => {
    const { pc } = await lab();
    const lines = (await pc.executeCommand('ssh-keyscan -t ed25519 10.0.0.2')).split('\n');

    expect(lines).toHaveLength(2);
    expect(isBanner(lines[0])).toBe(true);
    expect(isKey(lines[1])).toBe(true);
  });
});

describe('on the Windows prompt', () => {
  it('writes the five banners, then the key', async () => {
    const { win } = await lab();
    const lines = (await win.executeCmdCommand('ssh-keyscan 10.0.0.2')).split('\n');

    expect(lines.slice(0, 5).every(isBanner)).toBe(true);
    expect(isKey(lines[lines.length - 1])).toBe(true);
  });
});

describe('connections beyond the descriptor limit', () => {
  const stubHost = (): SshKeyscanHost => ({
    resolve: (name) => name,
    probe: () => ({
      serverIdentification: 'SSH-2.0-OpenSSH_8.9p1',
      hostKey: { algorithm: 'ssh-ed25519', publicKey: 'AAAA' },
    }),
  });

  it('go in waves : the banners of a wave, its keys, then the next wave', () => {
    const hosts = Array.from({ length: 52 }, (_, index) => `10.1.0.${index + 1}`);
    const outcome = runSshKeyscanCommand(['-t', 'ed25519', ...hosts], stubHost());
    const shape = outcome.lines.map((line) => (line.stream === 'stderr' ? 'b' : 'k')).join('');

    expect(shape).toBe(`${'b'.repeat(52)}${'k'.repeat(52)}`);
  });

  it('start a second wave after 256 connections', () => {
    const hosts = Array.from({ length: 52 }, (_, index) => `10.1.0.${index + 1}`);
    const outcome = runSshKeyscanCommand(['-t', 'rsa,ecdsa,ed25519,ecdsa-sk,ed25519-sk', ...hosts], stubHost());
    const shape = outcome.lines.map((line) => (line.stream === 'stderr' ? 'b' : 'k')).join('');

    expect(shape).toBe(`${'b'.repeat(256)}${'k'.repeat(256)}${'b'.repeat(4)}${'k'.repeat(4)}`);
  });
});
