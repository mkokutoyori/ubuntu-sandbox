/*
 * `show etherchannel summary` employait des drapeaux que sa legende ne
 * definissait pas, et en repetait un autre.
 *
 * L'AUTORITE est la transcription capturee, pas la documentation : la
 * regle 8 de `CLAUDE.md` le demande pour une mise en colonnes, et le
 * projet `ntc-templates` en porte deux pour cette commande
 * (`tests/cisco_ios/show_etherchannel_summary/`), l'une d'un Catalyst
 * 6500 (`show_etherchannel_summary.raw`), l'autre d'un IOS-XE
 * (`show_etherchannel_summary2.raw`). Ce que cette sonde affirme figure
 * MOT POUR MOT dans au moins l'une des deux :
 *
 *   - la legende definit R/S, U, f, M, u, w, d — les deux captures ;
 *     `P` et `s` sans les alias `/bndl`, `/susp` propres a l'IOS-XE,
 *     comme dans la capture 6500 et comme les drapeaux de port que le
 *     simulateur imprime ;
 *   - `Number of aggregators:` suit `Number of channel-groups in use:` —
 *     les deux ;
 *   - le filet d'en-tete, 47 tirets apres la troisieme croix — les deux ;
 *   - la ligne de groupe : groupe sur 7, port-channel sur 16, protocole
 *     sur 10, chaque port sur 15, et un retour a la ligne apres trois
 *     ports, la suite alignee a 33 colonnes — la capture 6500, seule a
 *     etre en espaces (l'IOS-XE est en tabulations).
 *
 * Mesure de depart, sur deux commutateurs relies par quatre liens en
 * LACP :
 *
 *   Flags:  D - down        P - bundled in port-channel
 *           I - stand-alone s - suspended
 *           H - Hot-standby (LACP only)
 *           s - suspended                     <- repete, et R/S/U absents
 *   Number of channel-groups in use: 1       <- pas d'agregateurs
 *   ------+-------------+-----------+-----------------------------------------
 *   1      Po1(SU)       LACP        Fa0/1(P) Fa0/2(P) Fa0/3(P) Fa0/4(P)
 *
 * `S` et `U`, sur la ligne meme du groupe, n'etaient definis nulle part.
 *
 * Ecrite a l'aveugle contre ces captures, avant de lire le rendu.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 6 cas tombent. Le sixieme est le TEMOIN : le groupe, son
 * protocole et ses quatre membres groupes sont la des deux cotes — c'est
 * la FORME qui change, pas le fait rendu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const PORTS = ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'FastEthernet0/4'];

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function summary(): Promise<string> {
  const a = new CiscoSwitch('switch-cisco', 'SW-A', 24, 0, 0);
  const b = new CiscoSwitch('switch-cisco', 'SW-B', 24, 300, 0);
  for (const p of PORTS) new Cable(`c-${p}`).connect(a.getPort(p)!, b.getPort(p)!);
  for (const sw of [a, b]) {
    for (const c of ['enable', 'configure terminal',
      'interface range FastEthernet0/1 - 4', 'channel-group 1 mode active', 'end']) {
      await sw.executeCommand(c);
    }
  }
  return a.executeCommand('show etherchannel summary');
}

describe('la legende definit ce que les lignes emploient', () => {
  it('chaque drapeau de la ligne du groupe est defini', async () => {
    const out = await summary();
    const legend = out.split('Number of channel-groups')[0];
    const group = out.split('\n').find(l => /^1\s+Po1\(/.test(l)) ?? '';
    const flags = new Set([...group.matchAll(/\(([A-Za-z]+)\)/g)].flatMap(m => [...m[1]]));

    expect(flags.size).toBeGreaterThan(0);
    for (const f of flags) expect(legend, f).toMatch(new RegExp(`\\b${f} - `));
  });

  it('aucune ligne de legende n\'est repetee', async () => {
    const legend = (await summary()).split('Number of channel-groups')[0];

    expect(legend.match(/s - suspended/g) ?? []).toHaveLength(1);
  });

  it('la legende est celle des captures', async () => {
    expect(await summary()).toContain([
      'Flags:  D - down        P - bundled in port-channel',
      '        I - stand-alone s - suspended',
      '        H - Hot-standby (LACP only)',
      '        R - Layer3      S - Layer2',
      '        U - in use      f - failed to allocate aggregator',
      '',
      '        M - not in use, minimum links not met',
      '        u - unsuitable for bundling',
      '        w - waiting to be aggregated',
      '        d - default port',
    ].join('\n'));
  });
});

describe('les compteurs et les colonnes', () => {
  it('le nombre d\'agregateurs suit celui des groupes', async () => {
    expect(await summary()).toContain(
      'Number of channel-groups in use: 1\nNumber of aggregators:           1');
  });

  it('le filet et la ligne du groupe suivent les largeurs capturees', async () => {
    const lines = (await summary()).split('\n').map(l => l.trimEnd());

    expect(lines).toContain(
      '------+-------------+-----------+-----------------------------------------------');
    const at = lines.findIndex(l => l.startsWith('1      Po1('));
    expect(lines[at]).toBe('1      Po1(SU)         LACP      Fa0/1(P)       Fa0/2(P)       Fa0/3(P)');
    expect(lines[at + 1]).toBe(`${' '.repeat(33)}Fa0/4(P)`);
  });
});

describe('le fait rendu ne change pas — le TEMOIN', () => {
  it('le groupe 1, en LACP, groupe ses quatre membres', async () => {
    const out = await summary();

    expect(out).toMatch(/^1\s+Po1\(SU\)\s+LACP/m);
    for (const p of ['Fa0/1', 'Fa0/2', 'Fa0/3', 'Fa0/4']) expect(out).toContain(`${p}(P)`);
  });
});
