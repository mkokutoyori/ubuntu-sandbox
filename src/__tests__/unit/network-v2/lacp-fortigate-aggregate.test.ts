/**
 * L'interface agregee FortiOS. Les drapeaux d'etat d'acteur et l'etat
 * voulu `ASAIEE` viennent de la documentation de diagnostic LACP de
 * Fortinet ; la CLI suit `config system interface` / `set type aggregate`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  actorStateFlags, ACTOR_STATE_SYNCED,
} from '@/network/devices/firewall/vendors/fortios/diag/aggregateRenderer';

interface Cmd { executeCommand(cmd: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

const FW_PORTS = ['port3', 'port4'];
const SW_PORTS = ['FastEthernet0/1', 'FastEthernet0/2'];
const LACP_PERIODIC_MS = 35_000;

async function definirAgregat(fw: FortiGate, options: string[] = []): Promise<string> {
  return taper(fw, ['config system interface', 'edit bond1', 'set type aggregate',
    'set member port3 port4', ...options, 'next', 'end']);
}

async function labo(options: string[] = []) {
  const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
  const cables = FW_PORTS.map((n, i) => {
    const c = new Cable(`c${i}`);
    c.connect(fw.getPort(n)!, sw.getPort(SW_PORTS[i])!);
    return c;
  });
  await taper(sw, ['enable', 'configure terminal']);
  for (const n of SW_PORTS) await taper(sw, [`interface ${n}`, 'channel-group 1 mode active', 'exit']);
  await sw.executeCommand('end');
  await definirAgregat(fw, options);
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { fw, sw, cables };
}

describe('la CLI FortiOS accepte l\'interface agregee', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('`set type aggregate` puis `set member` sont acceptes', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    expect(await definirAgregat(fw)).toBe('');
  });

  it('les trois modes LACP de FortiOS sont acceptes', async () => {
    for (const mode of ['static', 'passive', 'active']) {
      resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
      const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
      expect(await definirAgregat(fw, [`set lacp-mode ${mode}`]), mode).toBe('');
    }
  });

  it('`set lacp-speed`, `set min-links` et `set algorithm` sont acceptes', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    expect(await definirAgregat(fw, ['set lacp-speed fast', 'set min-links 2',
      'set algorithm L3'])).toBe('');
  });

  it('un mode LACP invente est refuse', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    const out = await taper(fw, ['config system interface', 'edit bond1',
      'set type aggregate', 'set lacp-mode zorglub']);
    expect(out).not.toBe('');
  });

  it('la configuration rendue reproduit tous les attributs', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    await definirAgregat(fw, ['set lacp-mode active', 'set lacp-speed fast',
      'set min-links 2', 'set algorithm L3']);
    const cfg = await fw.executeCommand('show system interface bond1');
    expect(cfg).toContain('set type aggregate');
    expect(cfg).toContain('set member "port3" "port4"');
    expect(cfg).toContain('set lacp-mode active');
    expect(cfg).toContain('set lacp-speed fast');
    expect(cfg).toContain('set min-links 2');
    expect(cfg).toContain('set algorithm L3');
  });

  it('les attributs d\'agregation ne sont proposes que sur un agregat', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    const out = await taper(fw, ['config system interface', 'edit port5',
      'set member port3']);
    expect(out).toContain('`member` does not apply in the current configuration');
  });
});

describe('l\'agregat FortiGate negocie avec un commutateur', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('le commutateur d\'en face bundle les deux liens', async () => {
    const { sw } = await labo(['set lacp-mode active', 'set min-links 1']);
    const out = await sw.executeCommand('show etherchannel summary');
    expect(out).toContain('Fa0/1(P)');
    expect(out).toContain('Fa0/2(P)');
  }, 30_000);

  it('`diagnose netlink aggregate list` rend etat, mode et algorithme', async () => {
    const { fw } = await labo(['set lacp-mode active', 'set min-links 1',
      'set algorithm L3']);
    expect(await fw.executeCommand('diagnose netlink aggregate list'))
      .toBe('bond1: up lacp-mode active algorithm L3');
  }, 30_000);

  it('l\'etat d\'acteur voulu est ASAIEE en vitesse lente', async () => {
    const { fw } = await labo(['set lacp-mode active', 'set min-links 1']);
    const out = await fw.executeCommand('diagnose netlink aggregate name bond1');
    expect(out).toContain(`actor state: ${ACTOR_STATE_SYNCED}`);
  }, 30_000);

  it('en vitesse rapide le second drapeau passe de S a F', async () => {
    const { fw } = await labo(['set lacp-mode active', 'set lacp-speed fast',
      'set min-links 1']);
    expect(await fw.executeCommand('diagnose netlink aggregate name bond1'))
      .toContain('actor state: AFAIEE');
  }, 30_000);

  it('le detail nomme le partenaire et l\'agregateur de chaque membre', async () => {
    const { fw, sw } = await labo(['set lacp-mode active', 'set min-links 1']);
    const sysIdSw = (await sw.executeCommand('show lacp sys-id')).split(',')[1].trim();
    const out = await fw.executeCommand('diagnose netlink aggregate name bond1');
    for (const n of FW_PORTS) expect(out, n).toContain(`slave: ${n}`);
    expect(out).toContain(`partner system MAC addr: ${sysIdSw}`);
    expect(out).toMatch(/aggregator ID: \d+/);
  }, 30_000);

  it('le detail porte la legende des six drapeaux', async () => {
    const { fw } = await labo(['set min-links 1']);
    const out = await fw.executeCommand('diagnose netlink aggregate name bond1');
    expect(out).toContain('(A|P) - LACP mode is Active or Passive');
    expect(out).toContain('(S|F) - LACP speed is Slow or Fast');
    expect(out).toContain('(A|I) - Aggregatable or Individual');
    expect(out).toContain('(I|O) - Port In sync or Out of sync');
    expect(out).toContain('(E|D) - Frame collection is Enabled or Disabled');
    expect(out).toContain('(E|D) - Frame distribution is Enabled or Disabled');
  }, 30_000);

  it('`diagnose netlink port` nomme le port de sortie d\'un flux', async () => {
    const { fw } = await labo(['set min-links 1']);
    const out = await fw.executeCommand(
      'diagnose netlink port bond1 src-ip 10.0.0.1 dst-ip 10.0.0.2');
    expect(out).toMatch(/^packet is transmitted from port port[34]$/);
  }, 30_000);

  it('le MEME flux sort toujours par le meme port', async () => {
    const { fw } = await labo(['set min-links 1']);
    const q = 'diagnose netlink port bond1 src-ip 10.0.0.1 dst-ip 10.0.0.2';
    expect(await fw.executeCommand(q)).toBe(await fw.executeCommand(q));
  }, 30_000);

  it('un agregat inconnu est nomme comme tel', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    expect(await fw.executeCommand('diagnose netlink aggregate name absent'))
      .toBe('aggregate interface absent does not exist');
  });

  it('`min-links` decide de l\'etat de l\'agregat', async () => {
    const { fw, cables } = await labo(['set min-links 2']);
    expect(await fw.executeCommand('diagnose netlink aggregate list'))
      .toContain('bond1: up');
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await fw.executeCommand('diagnose netlink aggregate list'))
      .toContain('bond1: down');
  }, 30_000);

  it('en mode static aucune LACPDU ne part', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
    FW_PORTS.forEach((n, i) => {
      new Cable(`s${i}`).connect(fw.getPort(n)!, sw.getPort(SW_PORTS[i])!);
    });
    let emises = 0;
    fw.getBus().subscribe('port.frame.tx-requested', (e: unknown) => {
      const f = (e as { payload?: { frame?: { payload?: { type?: string } } } }).payload?.frame;
      if (f?.payload?.type === 'lacp') emises += 1;
    });
    await definirAgregat(fw, ['set lacp-mode static']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(emises).toBe(0);
  }, 30_000);
});

describe('les drapeaux d\'etat d\'acteur', () => {
  it('ASAIEE est actif, lent, agregeable, synchronise, collecte et distribue', () => {
    expect(actorStateFlags('active', 'slow', true)).toBe('ASAIEE');
    expect(ACTOR_STATE_SYNCED).toBe('ASAIEE');
  });

  it('un passif hors synchronisation donne PSAODD', () => {
    expect(actorStateFlags('passive', 'slow', false)).toBe('PSAODD');
  });

  it('la vitesse rapide met F en seconde position', () => {
    expect(actorStateFlags('active', 'fast', true)).toBe('AFAIEE');
  });
});
