/**
 * `ping` : un resultat, un rendu — et l'adresse locale ne se perd pas.
 *
 * DISCRIMINATION : 8/9 tombent — 5 sur le COMPORTEMENT (le terminal
 * ecrivait « Host » la ou le routeur repond code 0, l'adresse etait
 * vide, une ligne inventee suivait les statistiques), 3 MECANIQUEMENT
 * (`formatPingFailureLine` n'existe pas encore). Le TEMOIN passe des
 * deux cotes, et le doit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { formatPingReplyLine, formatPingFailureLine } from '@/network/devices/linux/LinuxFormatHelpers';
import type { PingResult } from '@/network/devices/EndHost';

interface Cmd { executeCommand(cmd: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]) { for (const c of cmds) await d.executeCommand(c); }

async function laboratoire() {
  const routeur = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  new Cable('a').connect(a.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
  await taper(routeur, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'end']);
  await taper(a, ['ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1']);
  return { routeur, a };
}

describe('le terminal et le script rendent la meme ligne', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('TEMOIN — une reponse ordinaire arrive', async () => {
    const { a } = await laboratoire();
    const out = await a.executeCommand('ping -c 1 192.168.10.1');
    expect(out).toMatch(/64 bytes from 192\.168\.10\.1/);
    expect(out).toMatch(/, 0% packet loss/);
  });

  it('un code 0 est un reseau injoignable, des DEUX cotes', async () => {
    const { a } = await laboratoire();
    const brut: PingResult[] = await (a as any).executePingSequence(
      new IPAddress('203.0.113.9'), 1, 500);
    expect(brut).toHaveLength(1);
    const terminal = formatPingReplyLine(brut[0], 56);
    const scripte = await a.executeCommand('ping -c 1 203.0.113.9');
    expect(terminal).toContain('Destination Net Unreachable');
    expect(scripte).toContain('Destination Net Unreachable');
  });

  it('et les deux ecrivent MOT POUR MOT la meme ligne', async () => {
    const { a } = await laboratoire();
    const brut: PingResult[] = await (a as any).executePingSequence(
      new IPAddress('203.0.113.9'), 1, 500);
    const terminal = formatPingReplyLine(brut[0], 56)!;
    const scripte = await a.executeCommand('ping -c 1 203.0.113.9');
    expect(scripte.split('\n').some(l => l.trim() === terminal.trim())).toBe(true);
  });

  it('un voisin muet nomme l\'adresse LOCALE', async () => {
    const { a } = await laboratoire();
    const scripte = await a.executeCommand('ping -c 1 192.168.10.55');
    expect(scripte).toContain('From 192.168.10.10 icmp_seq=1 Destination Host Unreachable');
    expect(scripte).not.toMatch(/From\s{2,}/);
    expect(scripte).not.toContain('unknown');
  });

  it('le resultat brut porte l\'adresse locale, pas une chaine vide', async () => {
    const { a } = await laboratoire();
    const brut: PingResult[] = await (a as any).executePingSequence(
      new IPAddress('192.168.10.55'), 1, 500);
    expect(brut).toHaveLength(1);
    expect(brut[0].fromIP).toBe('192.168.10.10');
  });

  it('aucune ligne inventee apres les statistiques', async () => {
    const { a } = await laboratoire();
    const scripte = await a.executeCommand('ping -c 1 192.168.10.55');
    expect(scripte).not.toContain('ping: destination host unreachable');
    expect(scripte).toContain('+1 errors');
  });

  it('les codes RFC 792 sont ceux d\'iputils', () => {
    const cas: Array<[number, string]> = [
      [0, 'Destination Net Unreachable'],
      [1, 'Destination Host Unreachable'],
      [3, 'Destination Port Unreachable'],
      [10, 'Destination Host Prohibited'],
      [13, 'Packet filtered'],
    ];
    for (const [code, texte] of cas) {
      const r: PingResult = {
        success: false, rttMs: 0, ttl: 0, seq: 1, bytes: 0, fromIP: '10.0.0.1',
        error: `Destination unreachable (from 10.0.0.1) code ${code}`,
      };
      expect(formatPingFailureLine(r)).toBe(`From 10.0.0.1 icmp_seq=1 ${texte}`);
    }
  });

  it('une expiration de duree de vie garde sa forme', () => {
    const r: PingResult = {
      success: false, rttMs: 0, ttl: 0, seq: 3, bytes: 0, fromIP: '',
      error: 'Time to live exceeded (from 10.0.0.9)',
    };
    expect(formatPingFailureLine(r)).toBe('From 10.0.0.9 icmp_seq=3 Time to live exceeded');
  });

  it('un silence n\'est pas une erreur', () => {
    const r: PingResult = { success: false, rttMs: 0, ttl: 0, seq: 1, bytes: 0, fromIP: '' };
    expect(formatPingFailureLine(r)).toBeNull();
    expect(formatPingReplyLine(r, 56)).toBe('Request timeout for icmp_seq 1');
  });
});
