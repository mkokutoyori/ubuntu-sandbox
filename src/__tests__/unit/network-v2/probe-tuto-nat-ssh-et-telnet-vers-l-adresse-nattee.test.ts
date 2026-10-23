/**
 * Tuto NAT, le laboratoire R-AKWA / ISP / SRV-WEB avec `ip nat inside source static 192.168.10.10 203.0.113.3` :
 * `telnet 203.0.113.3` depuis le terminal de l'ISP et `ssh root@203.0.113.3` depuis le terminal de SRV-WEB.
 *
 * Mesure de depart. 203.0.113.3 n'est l'adresse d'AUCUN equipement : c'est l'adresse globale que le NAT donne a
 * SRV-WEB. Le ping la joignait (il passe par le fil), mais les deux clients interactifs interrogeaient d'abord
 * l'annuaire du plan de cables pour trouver « l'equipement qui porte cette adresse » :
 *   - `launchTelnet` (terminal IOS, Linux, Windows) appelait `findHostByAddress` et, sans proprietaire, repondait
 *     « Connection timed out » sans emettre un seul paquet, alors que 203.0.113.9 (porte par EXT) ouvrait ;
 *   - `ssh` (terminal Linux) passait par `peerLiveness`, dont la documentation dit « un pair qui n'est pas une
 *     adresse qu'on peut placer sur la topologie est repute vivant » mais dont le code concluait « No route to host »
 *     pour toute adresse sans proprietaire, avant meme la poignee de main TCP.
 * Desormais l'adresse litterale va droit au fil : SYN reel, traduit par le NAT du routeur, et la reponse (SYN-ACK, RST
 * ou silence) decide.
 *
 * Avant la correction (git stash push -- src/network src/terminal) : 4 cas sur 6 tombent (telnet ouvert, telnet refuse, ssh joint le
 * serveur, ssh sur port ferme). Passent dans les deux etats : le temoin du laboratoire (203.0.113.9 est
 * joignable en telnet et en ssh) et le ping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoTerminalSession } from '@/terminal/sessions';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PAT = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';
const STATIC = 'ip nat inside source static 192.168.10.10 203.0.113.3';

const key = (name: string): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function typed(session: TerminalSession, command: string, waitMs: number): Promise<string> {
  const from = session.lines.length;
  session.setInput(command);
  session.handleKey(key('Enter'));
  await pause(waitMs);
  return session.lines.slice(from).map((line) => line.text).join('\n');
}

async function ispTerminal(lab: Awaited<ReturnType<typeof tutoNatLab>>): Promise<CiscoTerminalSession> {
  const session = new CiscoTerminalSession('isp', lab.isp);
  await session.init();
  for (let i = 0; i < 40 && session.isBooting; i++) await pause(30);
  await typed(session, 'enable', 100);
  return session;
}

describe('the address the NAT gives to SRV-WEB, reached from the terminals', () => {
  it('witness: EXT (203.0.113.9) answers telnet from the ISP terminal and ssh from the SRV-WEB terminal', async () => {
    const lab = await tutoNatLab([PAT, STATIC]);
    await lab.ext.executeCommand('sudo nc -l -p 23 &');
    expect(await typed(await ispTerminal(lab), 'telnet 203.0.113.9', 600)).toContain('Open');
    expect(await typed(new LinuxTerminalSession('srv', lab.srv), 'ssh root@203.0.113.9', 1500)).toContain("authenticity of host '203.0.113.9");
  });

  it('telnet 203.0.113.3 from the ISP terminal opens the connection translated to SRV-WEB', async () => {
    const lab = await tutoNatLab([PAT, STATIC]);
    await lab.srv.executeCommand('sudo nc -l -p 23 &');
    const output = await typed(await ispTerminal(lab), 'telnet 203.0.113.3', 600);
    expect(output).toContain('Open');
    expect(output).not.toContain('timed out');
  });

  it('telnet 203.0.113.3 is refused by SRV-WEB when nothing listens on port 23, not timed out', async () => {
    const lab = await tutoNatLab([PAT, STATIC]);
    expect(await typed(await ispTerminal(lab), 'telnet 203.0.113.3', 600)).toContain('% Connection refused by remote host');
  });

  it('ssh root@203.0.113.3 from the SRV-WEB terminal reaches its own translated address instead of "No route to host"', async () => {
    const lab = await tutoNatLab([PAT, STATIC]);
    const output = await typed(new LinuxTerminalSession('srv', lab.srv), 'ssh root@203.0.113.3', 1500);
    expect(output).not.toContain('No route to host');
    expect(output).toContain("authenticity of host '203.0.113.3");
  });

  it('ssh to a translated address of a closed port says Connection refused', async () => {
    const lab = await tutoNatLab([PAT, STATIC]);
    const output = await typed(new LinuxTerminalSession('srv', lab.srv), 'ssh -p 2222 root@203.0.113.3', 1500);
    expect(output).toContain('Connection refused');
  });

  it('witness: ping 203.0.113.3 from the SRV-WEB terminal answers', async () => {
    const lab = await tutoNatLab([PAT, STATIC]);
    expect(await typed(new LinuxTerminalSession('srv', lab.srv), 'ping -c 1 203.0.113.3', 800)).toContain('1 received');
  });
});
