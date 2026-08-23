/**
 * MSTP — la region est identifiee par un CONDENSE, et hors d'une region
 * on n'echange que le CIST (IEEE 802.1Q §13.7/§13.8).
 *
 * Les MSTI voyageaient sous leur seul NUMERO : deux commutateurs dont
 * les tables VLAN->instance different echangeaient donc des BPDU sur des
 * instances qui ne se correspondent pas, chacun croyant parler de la
 * meme chose. La norme identifie la region par le triplet nom /
 * revision / condense, et un port qui entend une autre region est un
 * port de FRONTIERE : il ne garde que le CIST.
 *
 * Le condense est le vrai HMAC-MD5 de `src/crypto/mac/hmac.ts` sur la
 * table des 4096 VLAN en gros-boutien, sous la cle fixe de la norme. La
 * cle et la disposition de la table sont attestees contre `mstpd`
 * (`mstp.c`/`mstp.h`, la mise en oeuvre libre de reference), et le
 * resultat pour une region VIDE est
 * `AC36177F50283CD4B83821D8AB26DE62` — la valeur que TOUT commutateur
 * Cisco affiche par defaut, ce qui verifie la cle et la table par un
 * troisieme chemin.
 *
 * Discrimine par `git stash` de `StpAgent.ts`, `stp/types.ts` et
 * `CiscoSwitchShell.ts` : 7 des 12 cas tombent. Les 5 qui passent des
 * deux cotes sont les cas du seul `MstConfigId.ts`, fichier NEUF que ce
 * `stash` ne retire pas — ils eprouvent le condense, pas son emploi. Et
 * un mot sur le TEMOIN, qui tombe lui aussi : ce n'est pas parce que le
 * comportement differait avant, mais parce qu'il lit un accesseur qui
 * n'existait pas ; ce qu'il mesure — deux tables identiques font une
 * seule region — est vrai des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  mstConfigDigest, mstConfigIdentifier, sameMstRegion, vlansMappedToInstanceZero,
} from '@/network/stp/MstConfigId';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const VIDE = 'AC36177F50283CD4B83821D8AB26DE62';

async function commutateur(
  nom: string, region: { name: string; revision: number; instances: [number, string][] },
): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', nom, 24);
  const lignes = [
    'enable', 'configure terminal', 'spanning-tree mode mst',
    'spanning-tree mst configuration',
    `name ${region.name}`, `revision ${region.revision}`,
    ...region.instances.map(([id, vlans]) => `instance ${id} vlan ${vlans}`),
    'exit', 'end',
  ];
  for (const l of lignes) await sw.executeCommand(l);
  return sw;
}

const agent = (sw: CiscoSwitch) =>
  (sw as unknown as { getStpAgent(): import('@/network/stp/StpAgent').StpAgent }).getStpAgent();

describe('le condense de region est celui de la norme', () => {
  it('une region VIDE donne le condense que toute machine Cisco affiche', () => {
    expect(mstConfigDigest(new Map())).toBe(VIDE);
  });

  it('associer un VLAN change le condense', () => {
    expect(mstConfigDigest(new Map([[1, '10']]))).not.toBe(VIDE);
  });

  it('deux tables identiques ecrites differemment donnent le MEME condense', () => {
    const a = mstConfigDigest(new Map([[1, '10,11,12']]));
    const b = mstConfigDigest(new Map([[1, '10-12']]));
    expect(a).toBe(b);
  });

  it('le condense ne depend NI du nom NI de la revision', () => {
    const a = mstConfigIdentifier({ name: 'RG1', revision: 1, instances: new Map([[1, '10']]) });
    const b = mstConfigIdentifier({ name: 'RG2', revision: 7, instances: new Map([[1, '10']]) });
    expect(a.digest).toBe(b.digest);
    expect(sameMstRegion(a, b)).toBe(false);
  });

  it('l instance 0 recoit ce qui n est associe a personne d autre', () => {
    expect(vlansMappedToInstanceZero(new Map([[1, '10']]))).toBe('1-9,11-4094');
    expect(vlansMappedToInstanceZero(new Map())).toBe('1-4094');
  });

  it('la vue Cisco rend le condense, et la vue sans `digest` ne le rend pas', async () => {
    const sw = await commutateur('SW1', { name: 'RG1', revision: 1, instances: [[1, '10']] });
    const avecDigest = await sw.executeCommand('show spanning-tree mst configuration digest');
    expect(avecDigest).toContain('Digest');
    expect(avecDigest).toContain(mstConfigDigest(new Map([[1, '10']])));

    const sansDigest = await sw.executeCommand('show spanning-tree mst configuration');
    expect(sansDigest).not.toContain('Digest');
    expect(sansDigest).toContain('1-9,11-4094');
  });
});

describe('hors de sa region, un pont n echange que le CIST', () => {
  async function labo(regionB: { name: string; revision: number; instances: [number, string][] }) {
    const a = await commutateur('SW1', { name: 'RG1', revision: 1, instances: [[1, '10']] });
    const b = await commutateur('SW2', regionB);
    new Cable('c1').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);
    return { a, b };
  }

  it('TEMOIN — meme region : le voisin est vu sur l instance 1', async () => {
    const { a, b } = await labo({ name: 'RG1', revision: 1, instances: [[1, '10']] });
    expect(sameMstRegion(agent(a).getMstConfigIdentifier(), agent(b).getMstConfigIdentifier()))
      .toBe(true);
    expect(agent(b).getRootBridgeForInstance(1).mac).toBeDefined();
  });

  it('une table VLAN differente fait deux regions', async () => {
    const { a, b } = await labo({ name: 'RG1', revision: 1, instances: [[1, '20']] });
    expect(sameMstRegion(agent(a).getMstConfigIdentifier(), agent(b).getMstConfigIdentifier()))
      .toBe(false);
  });

  it('un NOM different suffit a faire deux regions', async () => {
    const { a, b } = await labo({ name: 'AUTRE', revision: 1, instances: [[1, '10']] });
    expect(sameMstRegion(agent(a).getMstConfigIdentifier(), agent(b).getMstConfigIdentifier()))
      .toBe(false);
  });

  it('une BPDU de MSTI venue d une autre region est ECARTEE', async () => {
    const { a, b } = await labo({ name: 'AUTRE', revision: 9, instances: [[1, '20']] });
    const identiteA = agent(a).getMstConfigIdentifier();

    const ecarte = (agent(b) as unknown as {
      isBoundaryBpdu(p: { mstConfigId?: unknown; cist?: boolean }, key: number): boolean;
    }).isBoundaryBpdu({ mstConfigId: identiteA }, 1);

    expect(ecarte).toBe(true);
  });

  it('la BPDU du CIST, elle, traverse la frontiere', async () => {
    const { a, b } = await labo({ name: 'AUTRE', revision: 9, instances: [[1, '20']] });
    const identiteA = agent(a).getMstConfigIdentifier();

    const ecarte = (agent(b) as unknown as {
      isBoundaryBpdu(p: { mstConfigId?: unknown; cist?: boolean }, key: number): boolean;
    }).isBoundaryBpdu({ mstConfigId: identiteA, cist: true }, 0);

    expect(ecarte).toBe(false);
  });

  it('une BPDU qui ne porte AUCUNE identite de region est traitee comme etrangere', async () => {
    const { b } = await labo({ name: 'RG1', revision: 1, instances: [[1, '10']] });
    const ecarte = (agent(b) as unknown as {
      isBoundaryBpdu(p: { mstConfigId?: unknown }, key: number): boolean;
    }).isBoundaryBpdu({}, 1);
    expect(ecarte).toBe(true);
  });
});
