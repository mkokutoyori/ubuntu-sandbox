/**
 * La machine a etats de CHURN, 802.3ad §43.4.17. Mesure contre
 * `ad_churn_machine` de `bond_3ad.c`, qui la nomme par sa clause, et
 * contre `bond_3ad_churn_desc` de `bond_3ad.h` pour les trois mots
 * qu'elle rend — `monitoring`, `churned`, `none`.
 *
 * Ce que la machine dit : soixante secondes apres qu'un port a ete
 * DERANGE, chaque extremite a-t-elle atteint la synchronisation ? Si
 * non, c'est un churn et il se compte. `/proc/net/bonding` ecrivait ces
 * quatre lignes en dur.
 *
 * DISCRIMINATION : 11 des 14 cas tombent contre l'etat d'avant. Les 3
 * autres sont nommes : le TEMOIN d'un port statique, qui n'a pas de
 * machine de churn et n'en avait pas non plus avant ; le cas des lignes
 * absentes quand il n'y a pas d'agregateur, que l'ancien rendu
 * satisfaisait deja puisqu'il ne les ecrivait pas la ; et « l'etat rendu
 * SUIT la machine », qui passait par COINCIDENCE — le zero en dur
 * ecrivait justement `none`, et c'est tout l'interet du cas precedent,
 * qui exige `monitoring` la ou le rendu figé ne pouvait pas le dire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { LacpAgent } from '@/network/lacp/LacpAgent';

interface Cmd { executeCommand(cmd: string): Promise<string> }

/** AD_CHURN_DETECTION_TIME : soixante secondes, `bond_3ad.c`. */
const CHURN_DETECTION_MS = 60_000;
/** current_while long : trois periodes lentes de trente secondes. */
const LONG_TIMEOUT_MS = 95_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

function agentDe(d: unknown): LacpAgent {
  return (d as { getLacpAgent(): LacpAgent }).getLacpAgent();
}

async function labo(modeSwitch = 'active', modeBond = '802.3ad') {
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
  srv.powerOn(); sw.powerOn();
  const cables: Cable[] = [];
  for (let i = 1; i <= 2; i++) {
    const c = new Cable(`c${i}`);
    c.connect(srv.getPorts()[i - 1], sw.getPort(`FastEthernet0/${i}`)!);
    cables.push(c);
  }
  await taper(sw, ['enable', 'configure terminal']);
  for (let i = 1; i <= 2; i++) {
    await taper(sw, [`interface FastEthernet0/${i}`,
      `channel-group 1 mode ${modeSwitch}`, 'exit']);
  }
  await sw.executeCommand('end');
  await taper(srv, ['ip link add bond0 type bond',
    `ip link set bond0 type bond mode ${modeBond}`,
    'ip link set eth0 master bond0', 'ip link set eth1 master bond0']);
  return { srv, sw, cables };
}

async function lignesChurn(srv: Cmd): Promise<string[]> {
  const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
  return out.split('\n').filter(l => l.includes('Churn'));
}

describe('la machine surveille, puis tranche', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un port qui vient d\'entrer dans l\'agregat est en surveillance', async () => {
    const { srv } = await labo();
    await vi.advanceTimersByTimeAsync(2_000);
    const info = agentDe(srv).getPortInfo('eth0')!;
    expect(info.churnActorState).toBe('monitoring');
    expect(info.churnPartnerState).toBe('monitoring');
  }, 30_000);

  it('la surveillance dure les soixante secondes de la norme', async () => {
    const { srv } = await labo();
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS - 2_000);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorState).toBe('monitoring');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorState).toBe('none');
  }, 30_000);

  it('un port synchronise n\'a PAS churne', async () => {
    const { srv } = await labo();
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    const info = agentDe(srv).getPortInfo('eth0')!;
    expect(info.churnActorState).toBe('none');
    expect(info.churnPartnerState).toBe('none');
    expect(info.churnActorCount).toBe(0);
    expect(info.churnPartnerCount).toBe(0);
  }, 30_000);

  it('un port qui n\'atteint jamais la synchronisation CHURNE', async () => {
    const { srv } = await labo('passive', '802.3ad lacp_active off');
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    const info = agentDe(srv).getPortInfo('eth0')!;
    expect(info.selected).toBe(false);
    expect(info.churnActorState).toBe('churned');
    expect(info.churnPartnerState).toBe('churned');
    expect(info.churnActorCount).toBe(1);
    expect(info.churnPartnerCount).toBe(1);
  }, 30_000);

  it('une fois tranchee, la machine se TAIT — le compteur ne s\'emballe pas', async () => {
    const { srv } = await labo('passive', '802.3ad lacp_active off');
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorCount).toBe(1);
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS * 3);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorCount).toBe(1);
  }, 30_000);

  it('l\'acteur et le partenaire sont juges SEPAREMENT', async () => {
    const { srv } = await labo();
    await vi.advanceTimersByTimeAsync(2_000);
    const info = agentDe(srv).getPortInfo('eth0')!;
    info.churnActorDeadlineMs = 0;
    info.churnActorState = 'churned';
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS);
    const apres = agentDe(srv).getPortInfo('eth0')!;
    expect(apres.churnActorState).toBe('churned');
    expect(apres.churnPartnerState).toBe('none');
  }, 30_000);
});

describe('ce qui DERANGE un port relance la machine', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un partenaire qui se tait fait sortir de CURRENT et relance', async () => {
    const { srv, sw } = await labo();
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorState).toBe('none');
    agentDe(sw).stop();
    await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorState).toBe('monitoring');
  }, 30_000);

  it('la relance mene a un churn si la synchronisation ne revient pas', async () => {
    const { srv, sw } = await labo();
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    agentDe(sw).stop();
    await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS + CHURN_DETECTION_MS + 2_000);
    const info = agentDe(srv).getPortInfo('eth0')!;
    expect(info.churnActorState).toBe('churned');
    expect(info.churnActorCount).toBe(1);
  }, 30_000);

  it('une LACPDU sur un port qui n\'etait plus CURRENT relance la machine', async () => {
    const { srv, sw } = await labo();
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    agentDe(sw).stop();
    await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS + CHURN_DETECTION_MS + 2_000);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorState).toBe('churned');
    agentDe(sw).start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(agentDe(srv).getPortInfo('eth0')!.churnActorState).toBe('monitoring');
  }, 30_000);

  it('le compteur est CUMULATIF : il survit au retour a la normale', async () => {
    const { srv, sw } = await labo();
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    agentDe(sw).stop();
    await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS + CHURN_DETECTION_MS + 2_000);
    agentDe(sw).start();
    await vi.advanceTimersByTimeAsync(35_000 + CHURN_DETECTION_MS + 2_000);
    const info = agentDe(srv).getPortInfo('eth0')!;
    expect(info.churnActorState).toBe('none');
    expect(info.churnActorCount).toBe(1);
  }, 30_000);

  it('un port STATIQUE n\'a pas de machine de churn — TEMOIN', async () => {
    const { srv } = await labo('on', 'balance-xor');
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    const info = agentDe(srv).getPortInfo('eth0');
    expect(info?.churnActorState ?? 'none').toBe('none');
    expect(info?.churnActorCount ?? 0).toBe(0);
  }, 30_000);
});

describe('`/proc/net/bonding` lit la machine au lieu d\'ecrire zero', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('les quatre lignes sont celles du noyau, dans son vocabulaire', async () => {
    const { srv } = await labo();
    await vi.advanceTimersByTimeAsync(2_000);
    const lignes = await lignesChurn(srv);
    expect(lignes).toContain('Actor Churn State: monitoring');
    expect(lignes).toContain('Partner Churn State: monitoring');
    expect(lignes).toContain('Actor Churned Count: 0');
    expect(lignes).toContain('Partner Churned Count: 0');
  }, 30_000);

  it('l\'etat rendu SUIT la machine', async () => {
    const { srv } = await labo();
    await vi.advanceTimersByTimeAsync(CHURN_DETECTION_MS + 2_000);
    const lignes = await lignesChurn(srv);
    expect(lignes).toContain('Actor Churn State: none');
    expect(lignes).toContain('Partner Churn State: none');
    expect(lignes).not.toContain('Actor Churn State: monitoring');
  }, 30_000);

  it('sans agregateur, les quatre lignes n\'apparaissent pas', async () => {
    const { srv } = await labo('on', 'balance-xor');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await lignesChurn(srv)).toEqual([]);
  }, 30_000);
});
