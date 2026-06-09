/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, it, beforeEach, vi } from 'vitest';
import { PropertiesPanel } from '@/components/network/PropertiesPanel';
import type { Connection, NetworkDeviceUI } from '@/store/networkStore';
import type { Equipment } from '@/network';

let storeState: ReturnType<typeof buildStoreState>;

function buildStoreState(overrides?: Partial<ReturnType<typeof buildStoreState>>) {
  return {
    getDevices: () => [] as NetworkDeviceUI[],
    connections: [] as Connection[],
    selectedDeviceId: null as string | null,
    selectedConnectionId: null as string | null,
    updateDevice: vi.fn(),
    selectDevice: vi.fn(),
    ...overrides,
  };
}

vi.mock('@/store/networkStore', () => ({
  useNetworkStore: () => storeState,
}));

vi.mock('@/network', () => ({
  isFullyImplemented: () => true,
}));

function fakeInstance(): Equipment {
  return { getMACTable: () => new Map<string, string>() } as unknown as Equipment;
}

function fakeDevice(overrides: Partial<NetworkDeviceUI>): NetworkDeviceUI {
  return {
    id: 'dev-1', type: 'linux-pc', name: 'Workstation', hostname: 'ws-1',
    x: 0, y: 0, interfaces: [], isPoweredOn: true,
    instance: fakeInstance(),
    ...overrides,
  };
}

function fakeConnection(overrides: Partial<Connection>): Connection {
  return {
    id: 'conn-1', type: 'ethernet',
    sourceDeviceId: 'dev-1', sourceInterfaceId: 'eth0',
    targetDeviceId: 'dev-2', targetInterfaceId: 'eth1',
    isActive: true,
    cable: {} as Connection['cable'],
    ...overrides,
  };
}

describe('PropertiesPanel (component)', () => {
  beforeEach(() => {
    storeState = buildStoreState();
  });

  it('renders empty state when nothing is selected', () => {
    render(<PropertiesPanel />);
    expect(
      screen.getByText('Select a device or connection to view properties'),
    ).toBeInTheDocument();
  });

  it('renders connection details when a connection is selected', () => {
    const devices: NetworkDeviceUI[] = [
      fakeDevice({ id: 'dev-1', name: 'Workstation' }),
      fakeDevice({ id: 'dev-2', type: 'cisco-router', name: 'Router', hostname: 'rtr-1' }),
    ];
    const connection = fakeConnection({});
    storeState = buildStoreState({
      getDevices: () => devices,
      connections: [connection],
      selectedConnectionId: 'conn-1',
    });

    render(<PropertiesPanel />);

    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Workstation')).toBeInTheDocument();
    expect(screen.getByText('Router')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Bandwidth')).toBeInTheDocument();
    expect(screen.getByText('Latency')).toBeInTheDocument();
  });

  it('renders device details when a device is selected', () => {
    const device = fakeDevice({
      id: 'dev-1',
      name: 'Workstation',
      interfaces: [
        {
          id: 'eth0', name: 'eth0', type: 'ethernet',
          macAddress: 'AA:BB:CC:DD:EE:FF',
          ipAddress: '10.0.0.10',
        },
      ],
    });
    storeState = buildStoreState({
      getDevices: () => [device],
      selectedDeviceId: 'dev-1',
    });

    render(<PropertiesPanel />);

    expect(screen.getByText('Workstation')).toBeInTheDocument();
    expect(screen.getByText('Interfaces (1)')).toBeInTheDocument();
    expect(screen.getByText('IP: 10.0.0.10')).toBeInTheDocument();
  });
});
