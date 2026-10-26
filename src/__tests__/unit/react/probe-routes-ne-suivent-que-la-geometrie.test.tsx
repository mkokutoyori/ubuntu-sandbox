/**
 * @vitest-environment jsdom
 *
 * Les routes des cables ne se recalculent que si la GEOMETRIE change.
 *
 * MESURE DE DEPART (Chromium, 200 postes, e2e/grande-topologie.spec.ts) :
 * `NetworkCanvas` memoisait `computeCableRoutes` sur l'identite du
 * tableau `devices`, or `getDevices()` rend un nouveau tableau des qu'un
 * seul equipement change d'aspect visible — une adresse IP posee dans un
 * terminal suffit. Les 200 `ip addr add` de la montee en charge
 * recalculaient donc 200 fois le routage complet : 22 s sur 43 s au
 * profil, la tache longue unique passant de 41 s a 17,7 s une fois le
 * calcul indexe sur ce qu'il lit vraiment (positions, extremites,
 * noms d'interface, zoom).
 *
 * DISCRIMINATION : un cas tombe avant correctif — celui du canvas, qui
 * rend DEUX calculs au lieu d'un quand une adresse est posee. Les quatre
 * cas du hook sont des gardes-fous du module neuf, verts des deux cotes
 * puisque `useCableRoutes` est vendu avec le correctif (le module est
 * present dans l'arbre meme quand on retablit l'ancien canvas) : le
 * temoin (un deplacement RECALCULE) et le cas du zoom et du cable de plus
 * prouvent que le cache ne se contente pas de ne jamais rien recalculer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as logic from '@/components/network/connection-line-logic';
import { useCableRoutes } from '@/components/network/useCableRoutes';
import type { Connection, NetworkDeviceUI } from '@/store/networkStore';

const device = (id: string, x: number, y: number, ip = ''): NetworkDeviceUI => ({
  id, type: 'linux-pc', name: id, hostname: id, x, y, isPoweredOn: true,
  interfaces: [{
    id: 'eth0', name: 'eth0', type: 'ethernet', ipAddress: ip, subnetMask: '',
    macAddress: '', isUp: true, hasCarrier: true, isOperational: true,
    acceptsCable: true, hasSocket: true,
  }],
} as unknown as NetworkDeviceUI);

const cable: Connection = {
  id: 'c1', sourceDeviceId: 'a', sourceInterfaceId: 'eth0',
  targetDeviceId: 'b', targetInterfaceId: 'eth0', type: 'ethernet',
} as unknown as Connection;

afterEach(() => { vi.restoreAllMocks(); });

describe('useCableRoutes', () => {
  it('TEMOIN : un premier rendu calcule, et un deplacement recalcule', () => {
    const spy = vi.spyOn(logic, 'computeCableRoutes');
    const { rerender } = renderHook(
      ({ devices }) => useCableRoutes([cable], devices, 1),
      { initialProps: { devices: [device('a', 0, 0), device('b', 300, 0)] } });
    expect(spy).toHaveBeenCalledTimes(1);
    rerender({ devices: [device('a', 0, 0), device('b', 300, 120)] });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('une adresse IP posee ne recalcule rien et rend LES MEMES routes', () => {
    const spy = vi.spyOn(logic, 'computeCableRoutes');
    const { result, rerender } = renderHook(
      ({ devices }) => useCableRoutes([cable], devices, 1),
      { initialProps: { devices: [device('a', 0, 0), device('b', 300, 0)] } });
    const before = result.current;
    rerender({ devices: [device('a', 0, 0, '10.0.0.1'), device('b', 300, 0)] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(before);
  });

  it('un changement de zoom recalcule', () => {
    const spy = vi.spyOn(logic, 'computeCableRoutes');
    const devices = [device('a', 0, 0), device('b', 300, 0)];
    const { rerender } = renderHook(
      ({ zoom }) => useCableRoutes([cable], devices, zoom), { initialProps: { zoom: 1 } });
    rerender({ zoom: 2 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('un cable de plus recalcule', () => {
    const spy = vi.spyOn(logic, 'computeCableRoutes');
    const devices = [device('a', 0, 0), device('b', 300, 0), device('c', 0, 200)];
    const second = { ...cable, id: 'c2', targetDeviceId: 'c' } as Connection;
    const { rerender } = renderHook(
      ({ cables }) => useCableRoutes(cables, devices, 1), { initialProps: { cables: [cable] } });
    rerender({ cables: [cable, second] });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('NetworkCanvas', () => {
  it('une adresse posee dans un terminal ne relance pas le routage des cables', async () => {
    const { render, act } = await import('@testing-library/react');
    const { useNetworkStore } = await import('@/store/networkStore');
    const { NetworkCanvas } = await import('@/components/network/NetworkCanvas');
    useNetworkStore.getState().clearAll();
    const store = useNetworkStore.getState();
    const a = store.addDevice('linux-pc', 10, 10);
    const b = store.addDevice('linux-pc', 300, 10);
    const snapshot = store.getDevices();
    store.addConnection(a.id, snapshot.find(d => d.id === a.id)!.interfaces[0].id,
      b.id, snapshot.find(d => d.id === b.id)!.interfaces[0].id);
    const spy = vi.spyOn(logic, 'computeCableRoutes');
    render(<NetworkCanvas />);
    const mounted = spy.mock.calls.length;
    expect(mounted).toBeGreaterThan(0);

    const machine = useNetworkStore.getState().deviceInstances.get(a.id) as unknown as {
      executeCommand(c: string): Promise<string>;
      getPortNames(): string[];
    };
    await act(async () => {
      await machine.executeCommand(`sudo ip addr add 10.9.9.1/24 dev ${machine.getPortNames()[0]}`);
      useNetworkStore.setState({});
    });
    expect(useNetworkStore.getState().getDevices().find(d => d.id === a.id)!
      .interfaces[0].ipAddress).toBe('10.9.9.1');
    expect(spy.mock.calls.length).toBe(mounted);
    useNetworkStore.getState().clearAll();
  });
});
