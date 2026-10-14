/**
 * Mesure de depart (TODO « les commandes d'une session SSH ne traversent pas le fil depuis la CLI
 * vendeur ») : depuis un routeur Cisco, `ssh -l alice hote` authentifiait sur le fil puis greffait
 * un enfant EN MEMOIRE sur l'objet du pair (`createSessionForDevice` + `adoptRemoteChild`) : deux
 * `whoami` et dix `whoami` coutaient le meme nombre de trames. Le terminal ouvre desormais un canal
 * shell sur la session et chaque ligne tapee y passe ; l'accueil (motd, « Last login ») vient du
 * serveur et le serveur ouvre lui-meme l'enregistrement de session (`who`).
 *
 * Laboratoire : routeur Cisco et serveur Linux sur un commutateur, compte alice, liste ancienne
 * de l'IOS 15 autorisee cote sshd (un IOS 15 n'offre que du SHA-1). Sur les cinq cas, deux tombent
 * avant la correction : le cout par commande (zero trame) et `who` sur le serveur (aucune session
 * enregistree) ; trois passent des deux cotes et sont nommes : le temoin « l'invite distante est celle
 * du serveur », la commande saisie sous l'identite du compte distant (l'enfant adopte executait deja
 * `id` comme alice) et la non-regression « un mauvais mot de passe est refuse ». Le fichier ne se
 * charge que si `LinuxTerminalSession` est importe avant `CiscoTerminalSession` : l'ordre
 * `CLITerminalSession` ↔ `sessionFactory` est circulaire avant la correction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import '@/terminal/sessions/LinuxTerminalSession';
import { installDefaultShells } from '@/shell/registerDefaults';
import { allowLegacyIosSshServer } from '@/__tests__/unit/network-v2/iosLegacySsh';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

let router: CiscoRouter;
let server: LinuxServer;
let term: CiscoTerminalSession;
let cable: Cable;

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await tick();
}

async function typeLine(line: string): Promise<void> {
  term.setInput(line);
  term.handleKey(key('Enter'));
  await tick();
}

async function login(password: string): Promise<void> {
  await typeLine('ssh -l alice 10.0.0.2');
  await until(() => term.currentInputMode.type === 'password');
  term.setPasswordBuf(password);
  term.handleKey(key('Enter'));
  await until(() => term.getPrompt().includes('alice@') || /denied/.test(screen()));
}

const screen = (): string => term.lines.map((l) => l.text).join('\n');

async function framesForCommands(count: number): Promise<number> {
  const before = cable.getStats().framesTransmitted;
  for (let i = 0; i < count; i++) {
    const seen = (screen().match(/^alice$/gm) ?? []).length;
    await typeLine('whoami');
    await until(() => (screen().match(/^alice$/gm) ?? []).length > seen);
  }
  return cable.getStats().framesTransmitted - before;
}

beforeEach(async () => {
  installDefaultShells();
  EquipmentRegistry.getInstance().clear();
  router = new CiscoRouter('R1', 0, 0);
  server = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  cable = new Cable('c0');
  cable.connect(router.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  for (const command of [
    'enable', 'configure terminal', 'hostname R1',
    `interface ${router.getPortNames()[0]}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await router.executeCommand(command);
  allowLegacyIosSshServer(server);
  await server.executeCommand('sudo useradd -m alice');
  await server.executeCommand('echo "alice:pw" | sudo chpasswd');
  term = new CiscoTerminalSession('t1', router);
  await term.init();
  await typeLine('enable');
});

describe('les commandes tapees dans un ssh de routeur Cisco traversent le cable', () => {
  it('temoin : l\'invite distante est celle du serveur', async () => {
    await login('pw');
    expect(term.getPrompt()).toMatch(/^alice@/);
  });

  it('dix commandes coutent plus de trames que deux', async () => {
    await login('pw');
    const two = await framesForCommands(2);
    const ten = await framesForCommands(10);
    expect(ten).toBeGreaterThan(two);
  }, 60000);

  it('le serveur voit la session ouverte (who)', async () => {
    await login('pw');
    expect(await server.executeCommand('who')).toMatch(/alice/);
  });

  it('la commande s\'execute sous l\'identite du compte distant', async () => {
    await login('pw');
    await typeLine('id -un');
    await until(() => /^alice$/m.test(screen()));
    expect(screen()).toMatch(/^alice$/m);
  });

  it('non-regression : un mauvais mot de passe est refuse', async () => {
    await login('faux');
    expect(screen()).toMatch(/Permission denied|denied/i);
    expect(term.getPrompt()).not.toMatch(/^alice@/);
  });
});
