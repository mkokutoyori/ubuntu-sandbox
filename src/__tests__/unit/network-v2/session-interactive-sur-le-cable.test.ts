/**
 * Phase 5 — le critère d'acceptation de l'audit pour la session
 * interactive : une commande tapée DANS une session `ssh` établie
 * doit voyager sur le câble, pas s'exécuter en local sur l'objet
 * distant saisi en mémoire.
 *
 * Compter les trames ne suffit pas : l'ouverture de session en émet
 * déjà beaucoup, si bien qu'un total non nul ne prouve rien. Ce qui
 * tranche est la DIFFÉRENCE — la même session, la même commande, deux
 * charges utiles très différentes. Si le contenu traverse, le nombre
 * d'octets suit ; s'il est lu en local, les deux coûtent pareil.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const CLI = '10.92.0.10';
const SRV = '10.92.0.20';
const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const tick = () => new Promise<void>((r) => setTimeout(r, 15));
function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
async function type(session: TerminalSession, cmd: string): Promise<void> {
  const before = session.lines.length;
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  for (let i = 0; i < 60 && session.lines.length === before; i++) await tick();
  await tick();
}

/** Une ligne tapée DANS un sous-shell passe par le tampon, pas par `input`. */
async function typeInSubShell(session: TerminalSession, cmd: string): Promise<void> {
  const before = session.lines.length;
  session.setInputBuf(cmd);
  session.handleKey(key('Enter'));
  for (let i = 0; i < 80 && session.lines.length === before; i++) await tick();
  await tick();
}
async function submitPassword(session: TerminalSession, value: string): Promise<void> {
  session.setPasswordBuf(value);
  session.handleKey(key('Enter'));
  await tick();
}
function lastLines(session: TerminalSession, n = 40): string[] {
  return session.lines.slice(-n).map((l) => l.text);
}

/**
 * Trames vues par le câble du client. `CableStats` ne compte QUE les
 * trames — il n'a pas de compteur d'octets — et lire un champ absent
 * rendrait 0 pour tout, ce qui ressemble à une preuve sans en être une.
 */
function frames(c: Cable): number {
  return c.getStats().framesTransmitted;
}

async function lab() {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const c1 = new Cable('c1');
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  c1.connect(client.getPorts()[0], sw.getPorts()[0]);
  client.getPorts()[0].configureIP(new IPAddress(CLI), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SRV), MASK);
  client.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash zoe');
  await server.executeCommand(`sh -c 'echo "zoe:secret" | chpasswd'`);
  return { client, server, c1 };
}

describe("Phase 5 — la session interactive fait voyager ses commandes", () => {
  it('la sortie d\'une commande grossit le trafic à proportion de sa taille', async () => {
    const { client, server, c1 } = await lab();
    await server.executeCommand(`sh -c 'echo court > /tmp/petit.txt'`);
    const gros = 'X'.repeat(4000);
    await server.executeCommand(`sh -c 'echo ${gros} > /tmp/gros.txt'`);
    expect((await server.executeCommand('wc -c /tmp/gros.txt'))).toMatch(/400[0-9]/);

    const term = new LinuxTerminalSession('t1', client);
    await term.init();
    await type(term, `ssh zoe@${SRV}`);
    if (term.currentInputMode.type === 'password') await submitPassword(term, 'secret');
    await tick();
    expect(lastLines(term, 20).join('\n')).toMatch(/zoe@/);

    const avantPetit = frames(c1);
    await typeInSubShell(term, 'cat /tmp/petit.txt');
    const coutPetit = frames(c1) - avantPetit;

    const avantGros = frames(c1);
    await typeInSubShell(term, 'cat /tmp/gros.txt');
    const coutGros = frames(c1) - avantGros;

    // La commande s'exécute bien à distance…
    expect(lastLines(term, 12).join('\n')).toMatch(/X{50,}/);
    // …et son résultat a traversé : 4000 octets coûtent plus de trames
    // que 6 (mesuré : 8 contre 4). Sans cette comparaison, un total non
    // nul aurait laissé croire que tout passe alors que seule
    // l'ouverture de session voyage.
    expect(coutPetit).toBeGreaterThan(0);
    expect(coutGros).toBeGreaterThan(coutPetit);
  }, 60_000);

  it('la référence : la commande tourne bien sur la machine DISTANTE', async () => {
    const { client, server } = await lab();
    await server.executeCommand('hostname SRV-DISTANT');

    const term = new LinuxTerminalSession('t1', client);
    await term.init();
    await type(term, `ssh zoe@${SRV}`);
    if (term.currentInputMode.type === 'password') await submitPassword(term, 'secret');
    await tick();

    await typeInSubShell(term, 'hostname');
    // Sans ce témoin, « ça a voyagé » ne dirait pas OÙ la commande a
    // tourné : un écho local coûterait des trames lui aussi.
    expect(lastLines(term, 6).join('\n')).toContain('SRV-DISTANT');
  }, 60_000);
});
