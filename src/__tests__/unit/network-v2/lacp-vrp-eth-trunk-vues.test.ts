/**
 * Les vues LACP de VRP, mesurees contre le gabarit `ntc-templates`
 * `huawei_vrp_display_eth-trunk`, qui dit la structure exacte des deux
 * formes (manuelle et LACP), et contre la documentation Huawei pour les
 * libelles de `Hash arithmetic`.
 *
 * Le bit LACP_Timeout est celui de la norme 802.1AX §5.4.7 : il DEMANDE
 * la cadence rapide au partenaire, qui doit l'honorer.
 *
 * DISCRIMINATION : 14 des 18 cas tombent contre l'etat d'avant. Les 4
 * autres sont nommes plutot que laisses a decouvrir. « B emet a la
 * seconde » passait DEJA, mais pas pour la raison qu'on croit : B ne
 * planifiait rien, il REPONDAIT a chaque trame de A — le correctif lui
 * donne sa propre cadence, ce que le cas ne sait pas distinguer.
 * « sans demande, la cadence reste lente » est le garde-fou de non-
 * regression, « un Eth-Trunk inexistant est refuse » etait deja juste,
 * et le dernier est le TEMOIN, dont c'est l'objet de passer des deux
 * cotes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  buildActorState, lacpStateBits, partnerWantsFastRate,
  LACP_FLAG_TIMEOUT, LACP_FLAG_DEFAULTED, LACP_FLAG_EXPIRED,
  type LacpPortInfo,
} from '@/network/lacp/types';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const LACP_PERIODIC_MS = 35_000;

function portFictif(over: Partial<LacpPortInfo> = {}): LacpPortInfo {
  return {
    portName: 'GigabitEthernet0/0/0', groupId: 1, mode: 'active',
    portPriority: 32768, state: 'bundled',
    partner: {
      systemPriority: 32768, systemId: '00:e0:fc:6e:bb:11',
      key: 1, portPriority: 32768, portNumber: 1, state: 0,
    },
    selected: true, bundled: true, lastRxMs: 1,
    churnActorState: 'none', churnPartnerState: 'none',
    churnActorCount: 0, churnPartnerCount: 0,
    churnActorDeadlineMs: 0, churnPartnerDeadlineMs: 0,
    ...over,
  };
}

async function laboVrp(mode = 'lacp-static', nb = 3) {
  const a = new HuaweiSwitch('switch-huawei', 'A', 24, 0, 0);
  const b = new HuaweiSwitch('switch-huawei', 'B', 24, 300, 0);
  a.powerOn(); b.powerOn();
  const cables: Cable[] = [];
  for (let i = 0; i < nb; i++) {
    const c = new Cable(`c${i}`);
    c.connect(a.getPort(`GigabitEthernet0/0/${i}`)!, b.getPort(`GigabitEthernet0/0/${i}`)!);
    cables.push(c);
  }
  for (const d of [a, b] as Cmd[]) {
    await d.executeCommand('system-view');
    await d.executeCommand('interface Eth-Trunk 1');
    await d.executeCommand(`mode ${mode}`);
    await d.executeCommand('quit');
    for (let i = 0; i < nb; i++) {
      await d.executeCommand(`interface GigabitEthernet0/0/${i}`);
      await d.executeCommand('eth-trunk 1');
      await d.executeCommand('quit');
    }
    await d.executeCommand('quit');
  }
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { a, b, cables };
}

describe('le bit LACP_Timeout de la norme 802.1AX', () => {
  it('la cadence rapide est ANNONCEE dans l\'etat de l\'acteur', () => {
    const p = portFictif();
    expect(buildActorState('active', p, false) & LACP_FLAG_TIMEOUT).toBe(0);
    expect(buildActorState('active', p, true) & LACP_FLAG_TIMEOUT).toBe(LACP_FLAG_TIMEOUT);
  });

  it('un partenaire sans information est DEFAULTED', () => {
    expect(buildActorState('active', portFictif({ partner: null }), false)
      & LACP_FLAG_DEFAULTED).toBe(LACP_FLAG_DEFAULTED);
    expect(buildActorState('active', portFictif(), false)
      & LACP_FLAG_DEFAULTED).toBe(0);
  });

  it('un port expire porte le bit EXPIRED', () => {
    expect(buildActorState('active', portFictif({ state: 'expired' }), false)
      & LACP_FLAG_EXPIRED).toBe(LACP_FLAG_EXPIRED);
  });

  it('les huit bits se lisent dans l\'ordre de la norme', () => {
    expect(lacpStateBits(buildActorState('active', portFictif(), false))).toBe('10111100');
    expect(lacpStateBits(buildActorState('active', portFictif({
      selected: false, bundled: false, state: 'standalone', partner: null,
    }), false))).toBe('10100010');
    expect(lacpStateBits(0)).toBe('00000000');
  });

  it('la demande du partenaire se LIT dans son etat', () => {
    expect(partnerWantsFastRate(LACP_FLAG_TIMEOUT)).toBe(true);
    expect(partnerWantsFastRate(0)).toBe(false);
  });
});

describe('un partenaire qui demande la cadence rapide est HONORE', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function laboMixte() {
    const a = new CiscoSwitch('switch-cisco', 'A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'B', 24, 300, 0);
    a.powerOn(); b.powerOn();
    for (let i = 1; i <= 2; i++) {
      new Cable(`c${i}`).connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
    }
    for (const d of [a, b] as Cmd[]) {
      for (const c of ['enable', 'configure terminal',
        'interface FastEthernet0/1', 'channel-group 1 mode active', 'exit',
        'interface FastEthernet0/2', 'channel-group 1 mode active', 'exit', 'end']) {
        await d.executeCommand(c);
      }
    }
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    return { a, b };
  }

  it('le voisin d\'un port en cadence rapide lit le bit dans son partenaire', async () => {
    const { a, b } = await laboMixte();
    a.getLacpAgent().setFastRate(true);
    await vi.advanceTimersByTimeAsync(2_000);
    const chezB = b.getLacpAgent().getPortInfo('FastEthernet0/1');
    expect(chezB?.partner).toBeTruthy();
    expect(partnerWantsFastRate(chezB!.partner!.state)).toBe(true);
  }, 30_000);

  it('B emet a la seconde bien que sa PROPRE cadence soit lente', async () => {
    const { a, b } = await laboMixte();
    a.getLacpAgent().setFastRate(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(b.getLacpAgent().getConfig().fastRate).toBe(false);
    const avant = b.getLacpAgent().getStatistics('FastEthernet0/1').sent;
    await vi.advanceTimersByTimeAsync(5_000);
    const apres = b.getLacpAgent().getStatistics('FastEthernet0/1').sent;
    expect(apres - avant).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('sans demande, la cadence reste lente des deux cotes', async () => {
    const { b } = await laboMixte();
    const avant = b.getLacpAgent().getStatistics('FastEthernet0/1').sent;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.getLacpAgent().getStatistics('FastEthernet0/1').sent - avant).toBe(0);
  }, 30_000);
});

describe('`display eth-trunk` en mode LACP rend le bloc LACP', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('le bloc Local porte les champs du gabarit', async () => {
    const { a } = await laboVrp();
    const out = await a.executeCommand('display eth-trunk 1');
    expect(out).toContain("Eth-Trunk1's state information is:");
    expect(out).toContain('Local:');
    expect(out).toMatch(/LAG ID: 1\s+WorkingMode: LACP-STATIC/);
    expect(out).toMatch(/Preempt Delay: Disabled\s+Hash arithmetic: According to SIP-XOR-DIP/);
    expect(out).toMatch(/System Priority: 32768\s+System ID: [0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(out).toMatch(/Operate status: up\s+Number Of Up Ports In Trunk: 3/);
  }, 30_000);

  it('la table ActorPortName et la table Partner sont toutes deux rendues', async () => {
    const { a } = await laboVrp();
    const out = await a.executeCommand('display eth-trunk 1');
    expect(out).toContain(
      'ActorPortName                Status   PortType PortPri PortNo PortKey PortState Weight');
    expect(out).toContain('Partner:');
    expect(out).toContain(
      'ActorPortName                SysPri   SystemID        PortPri PortNo PortKey PortState');
    for (let i = 0; i < 3; i++) {
      expect(out).toMatch(new RegExp(`GigabitEthernet0/0/${i}\\s+Selected\\s+1GE`));
    }
  }, 30_000);

  it('l\'etat de port rendu est celui de la norme, bit par bit', async () => {
    const { a } = await laboVrp();
    const out = await a.executeCommand('display eth-trunk 1');
    expect(out).toMatch(/GigabitEthernet0\/0\/0\s+Selected\s+1GE\s+32768\s+1\s+1\s+10111100\s+1/);
  }, 30_000);

  it('le mode MANUEL garde sa forme courte, avec le hachage', async () => {
    const { a } = await laboVrp('manual load-balance');
    const out = await a.executeCommand('display eth-trunk 1');
    expect(out).toMatch(/WorkingMode: MANUAL.*Hash arithmetic: According to/);
    expect(out).toContain('PortName                      Status      Weight');
    expect(out).not.toContain('Partner:');
  }, 30_000);

  it('un Eth-Trunk inexistant est refuse', async () => {
    const { a } = await laboVrp();
    expect(await a.executeCommand('display eth-trunk 9'))
      .toBe('Error: The Eth-Trunk 9 does not exist.');
  }, 30_000);
});

describe('`display interface Eth-Trunk` et `display trunkmembership`', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('le trunk se montre comme une interface', async () => {
    const { a } = await laboVrp();
    for (const c of ['display interface Eth-Trunk 1', 'display interface Eth-Trunk1']) {
      const out = await a.executeCommand(c);
      expect(out, c).toContain('Eth-Trunk1 current state : UP');
      expect(out, c).toContain('Line protocol current state : UP');
      expect(out, c).toContain('The Number of Ports in Trunk : 3');
      expect(out, c).toContain('The Number of UP Ports in Trunk : 3');
    }
  }, 30_000);

  it('la bande passante du trunk est la SOMME de ses liens actifs', async () => {
    const { a } = await laboVrp();
    expect(await a.executeCommand('display interface Eth-Trunk 1'))
      .toContain('Maximal BW: 3G, Current BW: 3G');
  }, 30_000);

  it('couper un lien retire sa bande passante et le compte des ports UP', async () => {
    const { a, cables } = await laboVrp();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    const out = await a.executeCommand('display interface Eth-Trunk 1');
    expect(out).toContain('The Number of UP Ports in Trunk : 2');
    expect(out).toContain('Maximal BW: 2G');
  }, 30_000);

  it('`display trunkmembership` nomme chaque port et son etat', async () => {
    const { a } = await laboVrp();
    const out = await a.executeCommand('display trunkmembership eth-trunk 1');
    expect(out).toContain('Trunk ID: 1');
    expect(out).toContain('Used status: VALID');
    expect(out).toContain('Working Mode : Static');
    expect(out).toContain('Number Of Ports in Trunk = 3');
    expect(out).toContain('Interface GigabitEthernet0/0/0, valid, operate up, weight = 1');
  }, 30_000);

  it('une interface ordinaire repond toujours — TEMOIN', async () => {
    const { a } = await laboVrp();
    expect(await a.executeCommand('display interface GigabitEthernet0/0/0'))
      .toContain('GigabitEthernet0/0/0 current state');
  }, 30_000);
});
