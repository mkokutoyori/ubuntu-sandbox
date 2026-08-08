/** @vitest-environment jsdom */

/**
 * Les deux dernières actions du Top 10 de l'audit interface (rapport 09).
 *
 * §9 — accessibilité : la fenêtre terminal se comportait comme un modal
 * sans le dire (ni `role`, ni `aria-modal`, ni nom accessible), et
 * fermer une fenêtre renvoyait le focus au `<body>` — un utilisateur au
 * clavier repartait du début de la page à chaque fermeture.
 *
 * §10 — `LiveDeviceStats` existait, testé, et son propre en-tête disait
 * « intentionally untouched by the existing UI » : un pont complet vers
 * l'état réel de l'équipement que rien n'ouvrait.
 */

import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, beforeEach, vi, expect } from 'vitest';
import { PropertiesPanel } from '@/components/network/PropertiesPanel';
import type { Connection, NetworkDeviceUI } from '@/store/networkStore';
import type { Equipment } from '@/network';

interface StoreState {
  getDevices: () => NetworkDeviceUI[];
  connections: Connection[];
  selectedDeviceId: string | null;
  selectedConnectionId: string | null;
  updateDevice: ReturnType<typeof vi.fn>;
  selectDevice: ReturnType<typeof vi.fn>;
}

let storeState: StoreState;

vi.mock('@/store/networkStore', () => ({
  useNetworkStore: () => storeState,
  isConnectionActive: () => true,
}));

vi.mock('@/network', () => ({
  isFullyImplemented: () => true,
}));

/**
 * Le panneau « Live » est monté pour de vrai ; seuls ses hooks de bus
 * sont neutralisés, car ils demandent un `Equipment` enregistré. Ce que
 * le test protège est le POINT D'ACCROCHE — que la section existe, se
 * déplie, et reçoive l'identifiant du bon équipement.
 */
vi.mock('@/components/network/devtools/LiveDeviceStats', () => ({
  LiveDeviceStats: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="live-device-stats">{deviceId}</div>
  ),
}));

function fakeDevice(overrides: Partial<NetworkDeviceUI> = {}): NetworkDeviceUI {
  return {
    id: 'dev-1', type: 'router-cisco', name: 'R1', hostname: 'r1',
    x: 0, y: 0, interfaces: [], isPoweredOn: true,
    instance: { getMACTable: () => new Map<string, string>() } as unknown as Equipment,
    ...overrides,
  };
}

beforeEach(() => {
  storeState = {
    getDevices: () => [fakeDevice()],
    connections: [],
    selectedDeviceId: 'dev-1',
    selectedConnectionId: null,
    updateDevice: vi.fn(),
    selectDevice: vi.fn(),
  };
});

describe('§10 — l\'état live de l\'équipement est atteignable depuis le panneau', () => {
  it('le panneau porte une section « Live state »', () => {
    render(<PropertiesPanel />);
    expect(screen.getByRole('button', { name: /live state/i })).toBeInTheDocument();
  });

  it('elle est repliée par défaut : un panneau fermé ne paie pas ses abonnements', () => {
    render(<PropertiesPanel />);
    expect(screen.getByRole('button', { name: /live state/i }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('live-device-stats')).not.toBeInTheDocument();
  });

  it('dépliée, elle rend le panneau live pour l\'équipement SÉLECTIONNÉ', () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /live state/i }));
    const panneau = screen.getByTestId('live-device-stats');
    expect(panneau).toBeInTheDocument();
    expect(panneau).toHaveTextContent('dev-1');
  });

  it('et elle suit la sélection, sans rester sur l\'équipement précédent', () => {
    const { rerender } = render(<PropertiesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /live state/i }));
    expect(screen.getByTestId('live-device-stats')).toHaveTextContent('dev-1');

    storeState = {
      ...storeState,
      getDevices: () => [fakeDevice({ id: 'dev-2', name: 'R2' })],
      selectedDeviceId: 'dev-2',
    };
    rerender(<PropertiesPanel />);
    expect(screen.getByTestId('live-device-stats')).toHaveTextContent('dev-2');
  });
});

describe('§9 — la fenêtre terminal se déclare pour ce qu\'elle est', () => {
  it('elle porte role=dialog, aria-modal et un nom accessible', async () => {
    const { LinuxPC } = await import('@/network/devices/LinuxPC');
    const { LinuxTerminalSession } = await import('@/terminal/sessions/LinuxTerminalSession');
    const { TerminalModal } = await import('@/components/network/TerminalModal');
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    const session = new LinuxTerminalSession('t-a11y', pc);

    render(<TerminalModal session={session} onClose={() => {}} />);
    const dialogue = screen.getByRole('dialog');
    expect(dialogue).toHaveAttribute('aria-modal', 'true');
    expect(dialogue).toHaveAccessibleName(/PC1/);
  });

  it('à la fermeture, le focus revient à l\'élément qui l\'avait ouverte', async () => {
    const { LinuxPC } = await import('@/network/devices/LinuxPC');
    const { LinuxTerminalSession } = await import('@/terminal/sessions/LinuxTerminalSession');
    const { TerminalModal } = await import('@/components/network/TerminalModal');
    const pc = new LinuxPC('linux-pc', 'PC2', 0, 0);
    pc.powerOn();
    const session = new LinuxTerminalSession('t-focus', pc);

    // L'équipement du canvas qui ouvre le terminal.
    const ouvrant = document.createElement('button');
    ouvrant.textContent = 'PC2';
    document.body.appendChild(ouvrant);
    ouvrant.focus();
    expect(document.activeElement).toBe(ouvrant);

    const { unmount } = render(<TerminalModal session={session} onClose={() => {}} />);
    // Le terminal prend le focus quand on y tape — ici on le prend
    // explicitement, sinon jsdom laisserait le focus sur l'ouvrant et
    // le test passerait sans rien prouver.
    const saisie = document.querySelector<HTMLInputElement>(
      '[data-testid="terminal-modal"] input');
    expect(saisie, 'pas de champ de saisie dans la fenêtre').not.toBeNull();
    saisie!.focus();
    expect(document.activeElement).toBe(saisie);

    unmount();

    expect(document.activeElement,
      'le focus est reparti au body : un utilisateur clavier perd sa place')
      .toBe(ouvrant);
    ouvrant.remove();
  });
});
