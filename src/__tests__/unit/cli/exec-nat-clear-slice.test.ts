/**
 * `clear ip nat …` passe au socle.
 *
 * La famille est propre au ROUTEUR — `registerNATPrivilegedCommands`
 * n'est branchee que sur son arbre privilegie — et chacune de ses formes
 * porte un refus qui EXPLIQUE : un VRF absent, une reserve absente, un
 * port hors bornes. Ce sont ces messages que la migration doit garder,
 * et une place typee les remplacerait par un caret nu.
 *
 * Le releve est pris AVANT : les cas d'acceptation et de refus sont
 * verts des deux cotes, les cas d'aide sont ce que la migration apporte.
 *
 * UN SEUL message change, et dans le sens de la fidelite. `clear ip nat
 * translation tcp` seul rendait
 * `% Incomplete command: tcp LOCAL LPORT GLOBAL GPORT.` — une phrase
 * qu'aucun IOS n'ecrit. Un vrai IOS rend `% Incomplete command.` et
 * NOMME les operandes dans `?`, ce que la place declaree fait
 * desormais. L'information ne disparait pas, elle rejoint l'endroit ou
 * la machine reelle la met.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Machine = { executeCommand(c: string): Promise<string>; cliHelp(i: string): string };

async function privilegie(): Promise<Machine> {
  const d = new CiscoRouter('R1', 0, 0) as unknown as Machine;
  await d.executeCommand('enable');
  return d;
}

const motsAides = (aide: string): string[] =>
  aide.split('\n').map(l => l.trim().split(/\s{2,}/)[0])
    .filter(m => m.length > 0 && !m.startsWith('%'));

describe('la famille NAT d EXEC reste acceptee', () => {
  it.each([
    'clear ip nat translation *',
    'clear ip nat translation inside',
    'clear ip nat translation inside 10.0.0.1',
    'clear ip nat translation outside',
    'clear ip nat translation outside 1.1.1.1',
    'clear ip nat translation tcp *',
    'clear ip nat translation tcp 10.0.0.1 80 1.1.1.1 8080',
    'clear ip nat translation udp 10.0.0.1 53 1.1.1.1 5353',
    'clear ip nat statistics',
  ])('`%s` est acceptee', async (commande) => {
    expect(await (await privilegie()).executeCommand(commande)).toBe('');
  });

  it.each([
    ['clear ip nat translation tcp', '% Incomplete command.'],
    ['clear ip nat translation udp', '% Incomplete command.'],
    ['clear ip nat translation tcp zorglub 80 1.1.1.1 8080', '% Invalid IP address zorglub.'],
    ['clear ip nat translation tcp 10.0.0.1 99999 1.1.1.1 8080', '% Invalid port number 99999.'],
    ['clear ip nat translation vrf', '% Incomplete command.'],
    ['clear ip nat translation vrf ZORG', '% VRF ZORG does not exist.'],
    ['clear ip nat translation pool', '% Incomplete command.'],
    ['clear ip nat translation pool ZORG', '% Pool ZORG does not exist.'],
    ['clear ip nat translation inside vrf ZORG', '% VRF ZORG does not exist.'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s` EXPLIQUE son refus', async (commande, attendu) => {
      expect(await (await privilegie()).executeCommand(commande)).toBe(attendu);
    });

  /*
   * `debug ip nat` reste au trie, et ces deux cas disent pourquoi : la
   * commande est enregistree dans le meme constructeur et n'a jamais
   * repondu depuis lui — c'est le repartiteur `debug ip` de
   * `CiscoShellBase` qui la sert, et lui seul ecrit
   * `IP NAT detailed debugging is on`. La migrer la ferait gagner et
   * changerait le message.
   */
  it('`debug ip nat` s arme et se desarme', async () => {
    const d = await privilegie();
    const on = await d.executeCommand('debug ip nat');
    expect(on).not.toContain('Invalid input');
    const off = await d.executeCommand('no debug ip nat');
    expect(off).not.toContain('Invalid input');
  });

  it('`debug ip nat detailed` garde le message du repartiteur', async () => {
    expect(await (await privilegie()).executeCommand('debug ip nat detailed'))
      .toBe('IP NAT detailed debugging is on');
  });

  it('la famille n existe pas en EXEC utilisateur', async () => {
    const d = new CiscoRouter('R2', 0, 0) as unknown as Machine;
    expect(await d.executeCommand('clear ip nat statistics'))
      .toContain('Invalid input');
  });
});

describe('ce que `?` annonce de la famille NAT', () => {
  it('`clear ip nat ?` annonce ses deux branches', async () => {
    const mots = motsAides((await privilegie()).cliHelp('clear ip nat '));
    expect(mots).toContain('statistics');
    expect(mots).toContain('translation');
  });

  it('`clear ip nat translation ?` annonce ses sept formes', async () => {
    const mots = motsAides((await privilegie()).cliHelp('clear ip nat translation '));
    for (const attendu of ['*', 'inside', 'outside', 'tcp', 'udp', 'vrf', 'pool']) {
      expect(mots, attendu).toContain(attendu);
    }
  });

  it('`clear ip nat translation vrf ?` annonce un nom EXIGE', async () => {
    const mots = motsAides((await privilegie()).cliHelp('clear ip nat translation vrf '));
    expect(mots).not.toContain('<cr>');
  });

  it('`clear ip nat translation tcp ?` NOMME les operandes', async () => {
    const aide = (await privilegie()).cliHelp('clear ip nat translation tcp ');
    expect(aide).toMatch(/address and port/);
    expect(motsAides(aide)).not.toContain('<cr>');
  });

  it('`clear ip nat statistics ?` ne prend rien', async () => {
    expect(motsAides((await privilegie()).cliHelp('clear ip nat statistics ')))
      .toEqual(['<cr>']);
  });
});
