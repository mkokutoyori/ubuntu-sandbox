/**
 * Les commandes d'une session SSH doivent etre COMPTABLES sur le fil.
 *
 * Ce fichier n'accompagne pas un correctif : il pose l'INSTRUMENT d'un
 * ecart mesure et consigne dans `TODO.md` (`[ssh] les commandes d'une
 * session SSH ne traversent le fil QUE depuis Linux`). Aucun cas ne
 * tombe avant / ne passe apres — les six passent des deux cotes, et
 * c'est voulu : ce sont des NON-REGRESSIONS sur le seul chemin deja
 * conforme au §4, plus le temoin qui prouve que la mesure sait dire
 * autre chose que zero.
 *
 * Methode du §4 : on ne compte pas les trames d'un echange, on compte
 * la DIFFERENCE entre le meme echange avec et sans la charge — un vrai
 * login met deja des trames sur le fil, donc un total non nul ne prouve
 * rien sur les commandes qui suivent. Releve sur
 * `Cable.getStats().framesTransmitted`, apres le login puis apres N
 * commandes, pour deux valeurs de N : c'est la PENTE qui discrimine.
 *
 * Mesure du jour, labo poste ─ commutateur ─ cible Linux :
 *
 *     origine          enfant adopte   N=2   N=10   par commande
 *     Linux (ici)           non         10     48      ~4,75
 *     Windows               oui          2      8      ~0,75
 *     CLI Cisco             oui          6      6       0
 *
 * Les deux dernieres lignes sont l'ecart consigne, pas un cas de ce
 * fichier : leur correction est le lot B de `PRD-SSH-Unification` §4bis.
 * Le jour ou elles prennent la pente de la premiere, elles rejoignent
 * ces cas ici.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((r) => setTimeout(r, 25));

async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 8 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 10; i++) await tick();
}

function runOnForeground(host: TerminalSession, line: string): void {
  host.foreground.setInput(line);
  host.foreground.setInputBuf(line);
  host.handleKey(key('Enter'));
}

interface Lab { origin: LinuxPC; target: LinuxPC; link: Cable }

async function buildLab(): Promise<Lab> {
  EquipmentRegistry.resetInstance();
  const origin = new LinuxPC('linux-pc', 'origin', 0, 0);
  const target = new LinuxPC('linux-pc', 'target', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  origin.powerOn(); target.powerOn(); sw.powerOn();
  const link = new Cable('origin-link');
  link.connect(origin.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('target-link').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await origin.executeCommand('ifconfig eth0 10.0.0.2');
  await target.executeCommand('ifconfig eth0 10.0.0.3');
  return { origin, target, link };
}

async function framesForCommands(lab: Lab, commands: number): Promise<{
  afterLogin: number; delta: number; adoptedChild: boolean;
}> {
  const host = new LinuxTerminalSession('h', lab.origin);
  await host.init?.();
  await sshLogin(host, 'ssh user@10.0.0.3', 'admin');
  const adoptedChild = host.foreground !== host;
  const afterLogin = lab.link.getStats().framesTransmitted;
  for (let i = 0; i < commands; i++) {
    runOnForeground(host, 'whoami');
    for (let k = 0; k < 4; k++) await tick();
  }
  return {
    afterLogin,
    delta: lab.link.getStats().framesTransmitted - afterLogin,
    adoptedChild,
  };
}

describe('les commandes d une session SSH traversent le fil', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  it('the login itself puts frames on the wire', async () => {
    const measured = await framesForCommands(lab, 0);
    expect(measured.afterLogin).toBeGreaterThan(0);
  }, 60_000);

  it('a Linux origin drives the remote shell over the channel, not an in-memory child', async () => {
    const measured = await framesForCommands(lab, 2);
    expect(measured.adoptedChild).toBe(false);
  }, 60_000);

  it('two commands put frames on the wire', async () => {
    const measured = await framesForCommands(lab, 2);
    expect(measured.delta).toBeGreaterThan(0);
  }, 60_000);

  it('ten commands put strictly more frames on the wire than two', async () => {
    const few = await framesForCommands(lab, 2);
    const many = await framesForCommands(await buildLab(), 10);
    expect(many.delta).toBeGreaterThan(few.delta);
  }, 60_000);

  it('the frame count per command stays above one', async () => {
    const measured = await framesForCommands(lab, 10);
    expect(measured.delta / 10).toBeGreaterThan(1);
  }, 60_000);
});
