/*
 * The "+18 more interfaces" line of the properties panel was a plain <div>: a
 * 26-port switch showed eight ports and no way to see the others. It is now a
 * button that reveals every interface, and a second click folds them back; the
 * choice belongs to the device (selecting another one starts folded), and the
 * label follows the locale.
 *
 * Measured before the change: 5 cases, 4 fall (the button does not exist); the
 * witness (eight interfaces shown, "+18 more interfaces" text) passes either way.
 */
/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest';
import { PropertiesPanel } from '@/components/network/PropertiesPanel';
import { setLocale } from '@/i18n';
import type { Connection, NetworkDeviceUI } from '@/store/networkStore';
import type { Equipment } from '@/network';

let selectedDeviceId = 'sw-1';

const ports = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}${index}`, name: `${prefix}${index}`, type: 'ethernet' as const,
  macAddress: `AA:BB:CC:DD:EE:${String(index).padStart(2, '0')}`, acceptsCable: true, hasSocket: true,
}));

function device(id: string, count: number): NetworkDeviceUI {
  return {
    id, type: 'linux-pc', name: id, hostname: id, x: 0, y: 0, interfaces: ports(count, 'Fa0/'),
    isPoweredOn: true, instance: { getMACTable: () => new Map<string, string>() } as unknown as Equipment,
  } as unknown as NetworkDeviceUI;
}

vi.mock('@/store/networkStore', () => ({
  useNetworkStore: () => ({
    getDevices: () => [device('sw-1', 26), device('sw-2', 12)],
    connections: [] as Connection[],
    selectedDeviceId,
    selectedConnectionId: null,
    updateDevice: vi.fn(),
    selectDevice: vi.fn(),
  }),
  isConnectionActive: () => true,
}));

vi.mock('@/network', () => ({ isFullyImplemented: () => true }));

beforeEach(() => { selectedDeviceId = 'sw-1'; setLocale('en'); });
afterEach(() => { cleanup(); setLocale('en'); });

describe('more interfaces', () => {
  it('witness: eight interfaces and the remainder are announced', () => {
    render(<PropertiesPanel />);
    expect(screen.getAllByText(/^Fa0\/\d+$/)).toHaveLength(8);
    expect(screen.getByText('+18 more interfaces')).toBeInTheDocument();
  });

  it('clicking the remainder reveals every interface', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByText('+18 more interfaces'));
    expect(screen.getAllByText(/^Fa0\/\d+$/)).toHaveLength(26);
  });

  it('a second click folds them back', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('toggle-all-interfaces'));
    expect(screen.getByTestId('toggle-all-interfaces')).toHaveTextContent('Show fewer interfaces');
    fireEvent.click(screen.getByTestId('toggle-all-interfaces'));
    expect(screen.getAllByText(/^Fa0\/\d+$/)).toHaveLength(8);
  });

  it('another device starts folded', () => {
    const view = render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('toggle-all-interfaces'));
    selectedDeviceId = 'sw-2';
    view.rerender(<PropertiesPanel />);
    expect(screen.getAllByText(/^Fa0\/\d+$/)).toHaveLength(8);
    expect(screen.getByTestId('toggle-all-interfaces')).toHaveTextContent('+4 more interfaces');
  });

  it('the labels follow the locale', () => {
    setLocale('fr');
    render(<PropertiesPanel />);
    expect(screen.getByTestId('toggle-all-interfaces')).toHaveTextContent('+18 interfaces de plus');
    fireEvent.click(screen.getByTestId('toggle-all-interfaces'));
    expect(screen.getByTestId('toggle-all-interfaces')).toHaveTextContent("Afficher moins d'interfaces");
  });
});
