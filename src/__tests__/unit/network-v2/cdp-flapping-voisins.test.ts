import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { getDefaultEventBus } from '@/events/EventBus';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

afterEach(() => { __setDefaultScheduler(null); });

function paireCablee(): [CiscoSwitch, CiscoSwitch] {
  const s1 = new CiscoSwitch('switch-cisco', 'SW1');
  const s2 = new CiscoSwitch('switch-cisco', 'SW2');
  new Cable('c').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);
  return [s1, s2];
}

interface EntreeVoisin { remoteHost: string; learnedAtMs: number; expiresAtMs: number }
type AgentCdp = {
  getNeighbors(): EntreeVoisin[];
  setEnabled(o: boolean): void;
  setTimerSec(s: number): void;
  setHoldtimeSec(s: number): void;
};
const agent = (s: CiscoSwitch) => (s as unknown as { getCdpAgent(): AgentCdp }).getCdpAgent();
const voisin = (s: CiscoSwitch, nom: string) =>
  agent(s).getNeighbors().find(n => n.remoteHost === nom);

describe('CDP — un voisin rafraîchi ne doit jamais expirer', () => {
  it('sans hello, le voisin expire au bout du hold-time', () => {
    const [s1, s2] = paireCablee();
    expect(voisin(s1, 'SW2')).toBeDefined();

    agent(s2).setEnabled(false);
    horloge.advance(181_000);

    expect(voisin(s1, 'SW2')).toBeUndefined();
  });

  it('le hello périodique rafraîchit vraiment l\'entrée', () => {
    const [s1] = paireCablee();
    const apprisAuDebut = voisin(s1, 'SW2')!.learnedAtMs;

    horloge.advance(200_000);

    const apres = voisin(s1, 'SW2');
    expect(apres).toBeDefined();
    expect(apres!.learnedAtMs).toBeGreaterThan(apprisAuDebut);
    expect(apres!.expiresAtMs).toBeGreaterThan(horloge.now());
  });

  it('une réinjection de bus plus fréquente que le timer ne fait pas battre le voisin', () => {
    const [s1, s2] = paireCablee();
    const bus = getDefaultEventBus();
    const battements: string[] = [];
    bus.subscribe('cdp.neighbor.expired', (e) => {
      const p = e.payload as unknown as { hostname?: string; remoteHost?: string };
      battements.push(`${p.hostname}:${p.remoteHost}`);
    });
    const apprisAuDebut = voisin(s1, 'SW2')!.learnedAtMs;

    for (let i = 0; i < 10; i++) {
      s1.setEventBus(bus);
      s2.setEventBus(bus);
      horloge.advance(30_000);
    }

    expect(battements).toEqual([]);
    expect(voisin(s1, 'SW2')!.learnedAtMs).toBeGreaterThan(apprisAuDebut);
    expect(voisin(s2, 'SW1')).toBeDefined();
  });

  it('le hold-time suit les valeurs configurées', () => {
    const [s1, s2] = paireCablee();
    for (const s of [s1, s2]) {
      agent(s).setTimerSec(10);
      agent(s).setHoldtimeSec(30);
    }
    horloge.advance(11_000);
    expect(voisin(s1, 'SW2')!.expiresAtMs - horloge.now()).toBeLessThanOrEqual(30_000);

    horloge.advance(120_000);
    expect(voisin(s1, 'SW2')).toBeDefined();

    agent(s2).setEnabled(false);
    horloge.advance(31_000);
    expect(voisin(s1, 'SW2')).toBeUndefined();
  });
});

describe('LLDP — même défaut, même correction', () => {
  interface EntreeLldp { systemName: string; learnedAtMs: number }
  type AgentLldp = { getNeighbors(): EntreeLldp[]; setEnabled(o: boolean): void };
  const lldp = (s: CiscoSwitch) =>
    (s as unknown as { getLldpAgent(): AgentLldp }).getLldpAgent();

  function paireLldp(): [CiscoSwitch, CiscoSwitch] {
    const [s1, s2] = paireCablee();
    lldp(s1).setEnabled(true);
    lldp(s2).setEnabled(true);
    return [s1, s2];
  }

  it('le voisin LLDP survit à des réinjections de bus répétées', () => {
    const [s1, s2] = paireLldp();
    const bus = getDefaultEventBus();
    const battements: string[] = [];
    bus.subscribe('lldp.neighbor.expired', (e) => {
      const p = e.payload as unknown as { remoteSystem?: string };
      battements.push(String(p.remoteSystem));
    });
    expect(lldp(s1).getNeighbors().map(n => n.systemName)).toContain('SW2');

    for (let i = 0; i < 10; i++) {
      s1.setEventBus(bus);
      s2.setEventBus(bus);
      horloge.advance(20_000);
    }

    expect(battements).toEqual([]);
    expect(lldp(s1).getNeighbors().map(n => n.systemName)).toContain('SW2');
  });

  it('mais expire quand même si le voisin se tait', () => {
    const [s1, s2] = paireLldp();
    expect(lldp(s1).getNeighbors().map(n => n.systemName)).toContain('SW2');

    lldp(s2).setEnabled(false);
    horloge.advance(121_000);

    expect(lldp(s1).getNeighbors().map(n => n.systemName)).not.toContain('SW2');
  });
});
