/**
 * Une `access-class` refusait Linux et laissait passer Windows.
 *
 * Meme maquette, meme routeur, meme mot de passe : un poste Linux non
 * autorise par l'`access-class` de la vty etait refuse, un poste Windows
 * atterrissait sur `R1#`. Deux raccourcis dans
 * `WindowsTerminalSession.submitSshPassword` : il tranchait le mot de
 * passe EN MEMOIRE (`verifyRemoteCredentials`, une chaine d'appels
 * directs sur l'objet `Equipment` du pair), ouvrait ensuite une connexion
 * reelle « pour que le distant voie quelque chose », et ne REGARDAIT PAS
 * son resultat : `outcome.kind === 'connected' ? outcome.session : null`,
 * puis on greffe l'enfant quoi qu'il arrive. Desormais le fil tranche —
 * `auth-failed` pilote les tentatives, tout autre refus arrete net.
 *
 * Et un defaut trouve en chemin : `wireSshLogin` rendait un
 * `CONNECTION_REFUSED` sous le mot « No route to host », ce que le
 * commentaire de `LinuxTerminalSession` refuse deja en toutes lettres
 * (« calling it a routing failure sends the operator to check cables
 * instead »). Deux ecritures d'un meme fait, divergentes.
 *
 * CE QUI N'EST PAS FERME ICI, et pourquoi aucun cas ne l'epingle : le
 * chemin NON INTERACTIF de Windows (`ssh hote "commande"`) rend toujours
 * la sortie de la commande a un client que l'`access-class` refuse. La
 * cause est mesuree et consignee dans `TODO.md` (`[ssh] le chemin non
 * interactif de Windows ne s'authentifie pas sur le fil`). Une premiere
 * garde a ete essayee et RETIREE : elle faisait tomber 33 cas sur 9
 * fichiers, parce que « pas de session sur le fil » est l'etat ORDINAIRE
 * de ce chemin — il n'a le plus souvent aucun justificatif a offrir — et
 * non le signe d'un refus. Les deux causes y sont indiscernables.
 *
 * Discrimination (`git stash push --`) : 2 cas sur 6 tombent avant
 * correctif — le refus interactif de Windows et « ce n'est pas une panne
 * de routage ». Les QUATRE qui passent des deux cotes sont nommes plutot
 * que laisses a deviner :
 *
 *   - « a Linux client denied by access-class is refused » et « a denied
 *     Linux client running a remote command gets no output » : non-
 *     regressions du chemin qui etait deja juste ;
 *   - « a Windows client permitted by access-class still gets in » : le
 *     TEMOIN. Sans lui, les refus ne prouveraient qu'un labo muet — il
 *     faut qu'un Windows AUTORISE entre pour que le refus d'un Windows
 *     BLOQUE veuille dire quelque chose ;
 *   - « a Windows client with a wrong password is refused » : le verdict
 *     en memoire refusait deja un mauvais mot de passe. Ce cas ne prouve
 *     donc rien du correctif, et le dire vaut mieux que de le compter
 *     comme une victoire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((r) => setTimeout(r, 25));

const WIN = '10.0.0.1';
const LIN = '10.0.0.2';
const RTR = '10.0.0.9';
const SECRET = 'Admin@123';

async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 12; i++) await tick();
}

const transcript = (s: TerminalSession): string => s.lines.map(l => l.text).join('\n');

async function lab(allowed: string): Promise<{ win: WindowsPC; lin: LinuxPC }> {
  EquipmentRegistry.resetInstance();
  const win = new WindowsPC('windows-pc', 'win', 0, 0);
  const lin = new LinuxPC('linux-pc', 'lin', 0, 0);
  const r1 = new CiscoRouter('R1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  [win, lin, r1].forEach(d => d.powerOn());
  sw.powerOn();
  new Cable('a').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(lin.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(r1.getPorts()[0], sw.getPort('FastEthernet0/3')!);
  await win.executeCommand(`netsh interface ip set address "Ethernet0" static ${WIN} 255.255.255.0`);
  await lin.executeCommand(`ifconfig eth0 ${LIN}`);
  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    'interface GigabitEthernet0/0', `ip address ${RTR} 255.255.255.0`, 'no shutdown', 'exit',
    `username admin privilege 15 secret ${SECRET}`, `enable secret ${SECRET}`,
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2',
    'ip access-list standard ONLY', `permit host ${allowed}`, 'exit',
    'line vty 0 4', 'access-class ONLY in', 'login local', 'transport input ssh', 'end',
  ]) await r1.executeCommand(c);
  return { win, lin };
}

describe('un refus du fil vaut sur Windows aussi', () => {
  beforeEach(() => { EquipmentRegistry.resetInstance(); });

  it('a Linux client denied by access-class is refused', async () => {
    const { lin } = await lab(WIN);
    const host = new LinuxTerminalSession('hL', lin);
    await host.init?.();
    await sshLogin(host, `ssh admin@${RTR}`, SECRET);

    expect(host.foreground).toBe(host);
  }, 60_000);

  it('a Windows client denied by access-class is refused', async () => {
    const { win } = await lab(LIN);
    const host = new WindowsTerminalSession('hW', win);
    await host.init?.();
    await sshLogin(host, `ssh admin@${RTR}`, SECRET);

    expect(host.foreground).toBe(host);
    expect(transcript(host)).not.toContain('R1#');
  }, 60_000);

  it('a Windows client permitted by access-class still gets in', async () => {
    const { win } = await lab(WIN);
    const host = new WindowsTerminalSession('hW', win);
    await host.init?.();
    await sshLogin(host, `ssh admin@${RTR}`, SECRET);

    expect(host.getPrompt()).toMatch(/^R1[>#]/);
    expect(transcript(host)).toContain('R1#');
  }, 60_000);

  it('a Windows client with a wrong password is refused', async () => {
    const { win } = await lab(WIN);
    const host = new WindowsTerminalSession('hW', win);
    await host.init?.();
    await sshLogin(host, `ssh admin@${RTR}`, 'wrong-one');

    expect(host.foreground).toBe(host);
    expect(transcript(host)).not.toContain('R1#');
  }, 60_000);

  it('a denied Linux client running a remote command gets no output', async () => {
    const { lin } = await lab(WIN);

    const out = await lin.executeCommand(
      `sshpass -p ${SECRET} ssh -o ConnectTimeout=1 admin@${RTR} "show clock"`);
    expect(out).not.toMatch(/UTC|\d{2}:\d{2}:\d{2}/);
  }, 60_000);

  it('a refused connection is not reported as a routing failure', async () => {
    const { win } = await lab(LIN);
    const host = new WindowsTerminalSession('hW', win);
    await host.init?.();
    await sshLogin(host, `ssh admin@${RTR}`, SECRET);

    expect(transcript(host)).toContain('Connection refused');
    expect(transcript(host)).not.toContain('No route to host');
  }, 60_000);
});
