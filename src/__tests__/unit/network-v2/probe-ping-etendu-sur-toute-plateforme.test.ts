/*
 * Le ping etendu d'IOS etait reserve au ROUTEUR par trois gardes
 * `instanceof Router` dans la session de terminal — le dialogue
 * (`buildInteractiveFlow`), son execution (`runExtendedPing`) et le ping
 * PROGRESSIF qui peint ses `!` au fil de l'eau (`tryStartCiscoPing`).
 *
 * Mesure, avant correctif, en EXEC privilegie :
 *
 *   Routeur  : `ping` nu  ->  mode `interactive-text`, « Protocol [ip]: »
 *   Catalyst : `ping` nu  ->  mode `normal`, « % Ping requires a target
 *                             IP address. »
 *
 * Cisco decrit le dialogue comme « an extended mode of the ping command
 * that is entered by typing ping in PRIVILEGED EXEC MODE, without a
 * destination IP address » — la condition porte sur le MODE, pas sur le
 * chassis. Un Catalyst est une machine IOS ; le sien s'ouvre comme les
 * autres.
 *
 * La phrase « % Ping requires a target IP address. » n'existe sur aucune
 * machine Cisco : c'etait l'aveu que le dialogue manquait. Elle disparait
 * de l'EXEC privilegie avec lui.
 *
 * Deuxieme mesure, sur le fil cette fois : `SwitchSvi.sendEcho` ecrivait
 * `dataSize: 56` EN DUR. La taille de datagramme etait donc acceptee par
 * la grammaire, rendue dans le transcript (« Sending 5, 200-byte ICMP
 * Echos »), et JAMAIS mise dans le paquet — le critere stocke, rendu, et
 * jamais evalue. Le routeur, lui, la pose depuis toujours : IOS compte le
 * datagramme IP ENTIER, donc la charge ICMP vaut la taille moins les 20
 * octets d'en-tete IP et les 8 de l'en-tete ICMP. Cette arithmetique est
 * maintenant ecrite UNE fois et lue par les deux plans de donnees.
 *
 * Meme chose pour DF et le type de service : le routeur les pose dans
 * l'en-tete (RFC 791 §3.1 pour le bit DF), le commutateur les ignorait.
 * Le dialogue les DEMANDE ; il fallait donc soit les honorer, soit ne pas
 * les demander.
 *
 * Troisieme : la GRAMMAIRE etait lue deux fois. Le socle analyse la ligne
 * de `ping` depuis le lot precedent, et `tryStartCiscoPing` la
 * re-analysait avec `parsePingArgs` pour decider s'il pouvait peindre les
 * marques progressivement. Deux lectures d'une meme grammaire finissent
 * par ne plus dire la meme chose — celle du terminal ignorait deja les
 * bornes que le socle venait d'appliquer. Le terminal demande desormais au
 * shell ce que le socle a DEJA analyse, et `parsePingArgs` disparait.
 *
 * Ce que ce lot ne touche pas, et pourquoi : en EXEC UTILISATEUR, `ping ?`
 * annonce toujours `<cr>` alors que `ping` nu y refuse. Le defaut est
 * anterieur a ce lot et il n'est pas ferme ici parce que le fermer demande
 * de savoir ce qu'une vraie machine repond a `ping` nu en EXEC
 * utilisateur — dialogue simple, dialogue etendu, ou refus. La
 * documentation atteignable ne nomme que le cas privilegie, et
 * support/cisco.com est bloque au telechargement par le mandataire de
 * sortie de ce reseau. Inventer la reponse serait exactement ce que ce
 * fichier reproche a la phrase ci-dessus.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 7 des 15 cas
 * tombent. Les 8 autres sont nommes :
 *
 *  - TEMOINS de plateforme : le ROUTEUR ouvrait deja son dialogue, posait
 *    deja ses questions dans l'ordre, et honorait deja la taille. Ses
 *    quatre cas passent des deux cotes, et c'est exactement ce qu'on veut
 *    d'eux : elargir la garde ne doit rien retirer a qui l'avait deja.
 *  - TEMOIN de phrase : le routeur n'ecrivait deja pas « % Ping requires
 *    a target IP address. » en EXEC privilegie.
 *  - TEMOINS de non-regression : le ping en UNE ligne et le refus d'un mot
 *    de trop, sur les deux plateformes. Ils tiennent la reecriture de
 *    `tryStartCiscoPing` — qui ne lit plus la ligne lui-meme — et sans eux
 *    un interceptteur qui avalerait tout passerait pour un succes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

const tick = () => new Promise<void>((r) => setTimeout(r, 15));

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (!session.isBooting) return;
    await tick();
  }
}

async function type(session: TerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await tick();
  await tick();
}

async function answer(session: TerminalSession, value: string): Promise<void> {
  session.setInputBuf(value);
  session.handleKey(key('Enter'));
  await tick();
  await tick();
}

const texte = (session: TerminalSession): string =>
  session.lines.map((l) => l.text).join('\n');

const invite = (session: TerminalSession): string => {
  const mode = session.currentInputMode;
  return mode.type === 'interactive-text' ? mode.promptText : '';
};

type Fabrique = () => CiscoRouter | CiscoSwitch;

const PLATEFORMES: ReadonlyArray<readonly [string, Fabrique]> = [
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
  ['catalyst', () => new CiscoSwitch('switch-cisco', 'S1', 8)],
];

async function session(faire: Fabrique, ...prelude: string[]): Promise<TerminalSession> {
  const d = faire();
  d.powerOn();
  const s = new CiscoTerminalSession('t', d as never);
  await s.init();
  await waitBoot(s);
  for (const c of prelude) await type(s, c);
  return s;
}

describe('le ping etendu est celui d\'IOS, pas celui du chassis', () => {
  describe.each(PLATEFORMES)('sur le %s', (_nom, faire) => {
    it('`ping` nu en EXEC privilegie ouvre le dialogue', async () => {
      const s = await session(faire, 'enable', 'ping');
      expect(s.currentInputMode.type).toBe('interactive-text');
      expect(invite(s)).toContain('Protocol [ip]:');
    });

    it('et n\'ecrit plus la phrase inventee', async () => {
      const s = await session(faire, 'enable', 'ping');
      expect(texte(s)).not.toMatch(/Ping requires a target IP address/);
    });

    it('le dialogue pose ses questions dans l\'ordre d\'IOS', async () => {
      const s = await session(faire, 'enable', 'ping');
      await answer(s, '');
      expect(invite(s)).toContain('Target IP address:');
      await answer(s, '10.0.0.1');
      expect(invite(s)).toContain('Repeat count [5]:');
    });

    it('et la taille demandee part sur le fil', async () => {
      const s = await session(faire, 'enable', 'ping');
      for (const reponse of ['', '10.0.0.1', '2', '200', '', '', '']) await answer(s, reponse);
      expect(texte(s)).toMatch(/Sending 2, 200-byte ICMP Echos to 10\.0\.0\.1/);
    });
  });
});

async function lanCommutee(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'Switch', 24, 0, 0);
  const pc = new LinuxPC('PC1', 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  for (const c of ['enable', 'configure terminal', 'interface Vlan1',
    'ip address 10.0.0.100 255.255.255.0', 'no shutdown', 'end']) {
    await sw.executeCommand(c);
  }
  await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  return sw;
}

function chargesEmises(sw: CiscoSwitch): number[] {
  const tailles: number[] = [];
  const pont = sw as unknown as {
    egressOnVlan(vlan: number, frame: { payload?: unknown }): void;
  };
  const original = pont.egressOnVlan.bind(pont);
  pont.egressOnVlan = (vlan, frame) => {
    const taille = (frame.payload as { payload?: { dataSize?: number } } | undefined)
      ?.payload?.dataSize;
    if (typeof taille === 'number') tailles.push(taille);
    original(vlan, frame);
  };
  return tailles;
}

describe('la taille de datagramme atteint VRAIMENT le paquet', () => {
  it('le Catalyst envoie une charge ICMP de la taille demandee', async () => {
    const sw = await lanCommutee();
    const tailles = chargesEmises(sw);

    const sortie = await sw.executeCommand('ping 10.0.0.1 size 200 repeat 1');

    expect(sortie, 'l\'echo n\'a pas abouti').toContain('Success rate is 100 percent');
    expect(tailles, 'aucun echo n\'a ete construit').not.toEqual([]);
    expect(tailles, `dataSize vus : ${tailles.join(', ')}`).toContain(172);
  });

  it('et la taille par defaut reste celle d\'IOS — le TEMOIN', async () => {
    const sw = await lanCommutee();
    const tailles = chargesEmises(sw);

    expect(await sw.executeCommand('ping 10.0.0.1 repeat 1'))
      .toContain('100-byte ICMP Echos');
    expect(tailles, `dataSize vus : ${tailles.join(', ')}`).toContain(72);
  });
});

describe('la ligne de `ping` n\'est plus lue deux fois', () => {
  it('`parsePingArgs` n\'a plus de lecteur Cisco', async () => {
    const source = await import('@/network/devices/shells/cisco/ciscoPing');
    expect(Object.keys(source)).not.toContain('parsePingArgs');
  });

  it.each(PLATEFORMES)('le ping en une ligne marche encore sur le %s — le TEMOIN',
    async (_nom, faire) => {
      const s = await session(faire, 'enable', 'ping 10.0.0.1 repeat 2');
      expect(texte(s)).toMatch(/Sending 2, 100-byte ICMP Echos to 10\.0\.0\.1/);
    });

  it.each(PLATEFORMES)('et un refus reste un refus sur le %s — le TEMOIN',
    async (_nom, faire) => {
      const s = await session(faire, 'enable', 'ping 10.0.0.1 zorglub');
      expect(texte(s)).toMatch(/Invalid input/);
    });
});
