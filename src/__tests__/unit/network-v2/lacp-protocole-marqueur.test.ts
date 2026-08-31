/**
 * Le Protocole Marqueur, 802.3ad §43.5 (802.1AX §6.5). Sa forme vient
 * de `include/net/bond_3ad.h`, qui cite la clause §43.5.3.2 : meme
 * ethertype et meme adresse de groupe qu'une LACPDU, distingue par son
 * sous-type 0x02, et repondu en changeant le seul TLV type.
 *
 * Les colonnes `Marker` des vues Cisco et Huawei etaient des ZEROS en
 * dur. Elles lisent maintenant un compteur, et ce compteur ne bouge que
 * pour un marqueur reellement arrive : aucun des constructeurs modelises
 * n'en ORIGINE — le noyau Linux le dit de lui-meme en toutes lettres —
 * donc `Sent` reste a zero, ce qui est la verite et non un manque.
 *
 * DISCRIMINATION : 8 des 11 cas tombent contre l'etat d'avant. Les 3
 * autres sont nommes : les deux TEMOINS de comptage LACPDU, qui doivent
 * passer des deux cotes, et le cas « Sent reste a zero », qui passait
 * parce que la colonne etait un zero en dur.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  ETHERTYPE_LACP, LACP_SLOW_MAC, MARKER_INFORMATION, MARKER_RESPONSE,
  type MarkerFrame,
} from '@/network/lacp/types';
import type { EthernetFrame } from '@/network/core/types';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const LACP_PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

function marqueur(over: Partial<MarkerFrame> = {}): MarkerFrame {
  return {
    type: 'lacp-marker', subtype: 0x02, version: 0x01,
    tlvType: MARKER_INFORMATION, markerLength: 0x16,
    requesterPort: 7, requesterSystem: '00:e0:fc:6e:bb:11',
    requesterTransactionId: 424242,
    ...over,
  };
}

function trameMarqueur(source: string, payload: MarkerFrame): EthernetFrame {
  return {
    srcMAC: new MACAddress(source),
    dstMAC: new MACAddress(LACP_SLOW_MAC),
    etherType: ETHERTYPE_LACP,
    payload,
  };
}

async function laboCisco() {
  const a = new CiscoSwitch('switch-cisco', 'A', 24, 0, 0);
  const b = new CiscoSwitch('switch-cisco', 'B', 24, 300, 0);
  a.powerOn(); b.powerOn();
  new Cable('c1').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(a.getPort('FastEthernet0/2')!, b.getPort('FastEthernet0/2')!);
  for (const d of [a, b] as Cmd[]) {
    await taper(d, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'channel-group 1 mode active', 'exit',
      'interface FastEthernet0/2', 'channel-group 1 mode active', 'end']);
  }
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { a, b };
}

describe('le marqueur est repondu, jamais origine', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un marqueur recu est COMPTE', async () => {
    const { a } = await laboCisco();
    a.getPort('FastEthernet0/1')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    expect(a.getLacpAgent().getMarkerStatistics('FastEthernet0/1').received).toBe(1);
  }, 30_000);

  it('la reponse part sur le MEME port', async () => {
    const { a } = await laboCisco();
    const vues: Array<{ iface: string; payload: unknown }> = [];
    a.attachCapture((t) => {
      if (t.direction === 'out' && (t.frame.payload as { type?: string })?.type === 'lacp-marker') {
        vues.push({ iface: t.iface, payload: t.frame.payload });
      }
    });
    a.getPort('FastEthernet0/2')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    expect(vues).toHaveLength(1);
    expect(vues[0].iface).toBe('FastEthernet0/2');
  }, 30_000);

  it('la reponse ne change QUE le TLV type', async () => {
    const { a } = await laboCisco();
    let recue: MarkerFrame | null = null;
    a.attachCapture((t) => {
      const p = t.frame.payload as MarkerFrame;
      if (t.direction === 'out' && p?.type === 'lacp-marker') recue = p;
    });
    const envoye = marqueur({ requesterPort: 9, requesterTransactionId: 7 });
    a.getPort('FastEthernet0/1')!.receiveFrame(trameMarqueur('00:e0:fc:6e:bb:11', envoye));
    expect(recue).not.toBeNull();
    expect(recue!.tlvType).toBe(MARKER_RESPONSE);
    expect(recue!.requesterPort).toBe(9);
    expect(recue!.requesterTransactionId).toBe(7);
    expect(recue!.requesterSystem).toBe(envoye.requesterSystem);
    expect(recue!.subtype).toBe(0x02);
    expect(recue!.markerLength).toBe(0x16);
  }, 30_000);

  it('une REPONSE recue est comptee et n\'en declenche aucune autre', async () => {
    const { a } = await laboCisco();
    let sorties = 0;
    a.attachCapture((t) => {
      if (t.direction === 'out'
        && (t.frame.payload as { type?: string })?.type === 'lacp-marker') sorties++;
    });
    a.getPort('FastEthernet0/1')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur({ tlvType: MARKER_RESPONSE })));
    const k = a.getLacpAgent().getMarkerStatistics('FastEthernet0/1');
    expect(k.responseReceived).toBe(1);
    expect(k.received).toBe(0);
    expect(sorties).toBe(0);
  }, 30_000);

  it('un marqueur sur un port hors agregat ne declenche rien', async () => {
    const { a } = await laboCisco();
    a.getPort('FastEthernet0/5')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    expect(a.getLacpAgent().getMarkerStatistics('FastEthernet0/5').received).toBe(0);
  }, 30_000);

  it('un marqueur ne touche PAS l\'etat de la negociation', async () => {
    const { a } = await laboCisco();
    const avant = a.getLacpAgent().getPortInfo('FastEthernet0/1')!.partner;
    a.getPort('FastEthernet0/1')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    const apres = a.getLacpAgent().getPortInfo('FastEthernet0/1')!;
    expect(apres.bundled).toBe(true);
    expect(apres.partner?.systemId).toBe(avant?.systemId);
  }, 30_000);

  it('`show lacp counters` lit le compteur au lieu d\'ecrire zero', async () => {
    const { a } = await laboCisco();
    a.getPort('FastEthernet0/1')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    const out = await a.executeCommand('show lacp counters');
    const ligne = out.split('\n').find(l => l.startsWith('Fa0/1'))!;
    const cols = ligne.trim().split(/\s+/);
    expect(cols[3]).toBe('0');
    expect(cols[4]).toBe('1');
    expect(cols[5]).toBe('1');
  }, 30_000);

  it('`Sent` reste a zero — aucun constructeur modelise n\'origine', async () => {
    const { a } = await laboCisco();
    a.getPort('FastEthernet0/1')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    expect(a.getLacpAgent().getMarkerStatistics('FastEthernet0/1').sent).toBe(0);
  }, 30_000);

  it('les compteurs LACPDU restent justes — TEMOIN', async () => {
    const { a } = await laboCisco();
    const avant = a.getLacpAgent().getStatistics('FastEthernet0/1');
    a.getPort('FastEthernet0/1')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    const apres = a.getLacpAgent().getStatistics('FastEthernet0/1');
    expect(apres.received).toBe(avant.received);
    expect(avant.received).toBeGreaterThan(0);
  }, 30_000);
});

describe('cote VRP', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function laboVrp() {
    const a = new HuaweiSwitch('switch-huawei', 'A', 24, 0, 0);
    const b = new HuaweiSwitch('switch-huawei', 'B', 24, 300, 0);
    a.powerOn(); b.powerOn();
    for (let i = 0; i < 2; i++) {
      new Cable(`c${i}`).connect(
        a.getPort(`GigabitEthernet0/0/${i}`)!, b.getPort(`GigabitEthernet0/0/${i}`)!);
    }
    for (const d of [a, b] as Cmd[]) {
      await taper(d, ['system-view', 'interface Eth-Trunk 1', 'mode lacp-static', 'quit']);
      for (let i = 0; i < 2; i++) {
        await taper(d, [`interface GigabitEthernet0/0/${i}`, 'eth-trunk 1', 'quit']);
      }
      await d.executeCommand('quit');
    }
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    return { a, b };
  }

  it('`display lacp statistics` lit le compteur', async () => {
    const { a } = await laboVrp();
    a.getPort('GigabitEthernet0/0/0')!.receiveFrame(
      trameMarqueur('00:e0:fc:6e:bb:11', marqueur()));
    const out = await a.executeCommand('display lacp statistics eth-trunk 1');
    const bloc = out.split('\n\n')[0].split('\n');
    const chiffres = bloc[bloc.length - 1].trim().split(/\s+/);
    expect(chiffres[2]).toBe('1');
    expect(chiffres[3]).toBe('1');
  }, 30_000);

  it('sans marqueur, les deux colonnes restent a zero — TEMOIN', async () => {
    const { a } = await laboVrp();
    const out = await a.executeCommand('display lacp statistics eth-trunk 1');
    const bloc = out.split('\n\n')[0].split('\n');
    const chiffres = bloc[bloc.length - 1].trim().split(/\s+/);
    expect(chiffres[2]).toBe('0');
    expect(chiffres[3]).toBe('0');
  }, 30_000);
});
