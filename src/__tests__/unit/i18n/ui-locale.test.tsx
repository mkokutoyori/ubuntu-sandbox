/** @vitest-environment jsdom */

/*
 * The interface follows the language the user picks: the toolbar, the
 * palette and the help dialog are rendered in French or English from the
 * same typed catalogues, the choice is shared by every component that reads
 * it (one external store, not one copy per component) and survives a reload.
 *
 * Witnesses prove the lab: in English the original strings are still
 * rendered, so the translation did not rewrite what the other tests and
 * the users read today.
 */

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Toolbar } from '@/components/network/Toolbar';
import { DevicePalette } from '@/components/network/DevicePalette';
import { HelpDialog } from '@/components/network/HelpDialog';
import { ConfirmDialog } from '@/components/network/ConfirmDialog';
import { MessageDialog } from '@/components/network/MessageDialog';
import { SaveTopologyDialog } from '@/components/network/SaveTopologyDialog';
import { OpenTopologyDialog } from '@/components/network/OpenTopologyDialog';
import { TOPOLOGY_SAVE_CAVEATS } from '@/store/topologySerializer';
import { PropertiesPanel } from '@/components/network/PropertiesPanel';
import { NetworkCanvas } from '@/components/network/NetworkCanvas';
import { InterfaceSelectorPopover } from '@/components/network/InterfaceSelectorPopover';
import { TerminalTaskbar } from '@/components/network/MinimizedTerminals';
import { LiveDeviceStats } from '@/components/network/devtools/LiveDeviceStats';
import type { TerminalSession } from '@/terminal/sessions/TerminalSession';
import { useNetworkStore } from '@/store/networkStore';
import { SettingsDialog, SettingsRegistry, type SettingsSection } from '@/components/settings';
import { simulationSettingsSection } from '@/components/settings/sections/simulationSection';
import { Timer } from 'lucide-react';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { DEVICE_CATEGORIES } from '@/network';
import { getLocale, setLocale, categoryLabel, deviceTypeDescription, translate } from '@/i18n';
import { MESSAGES, FRENCH_DEVICE_DESCRIPTIONS } from '@/i18n/messages';

const toolbar = () => (
  <Toolbar projectName="Lab" onProjectNameChange={() => undefined} hasDevices onClearAll={() => undefined} />
);

beforeEach(() => {
  localStorage.clear();
  setLocale('en');
  useNetworkStore.getState().clearAll();
});
afterEach(() => { cleanup(); __resetSimulationClock(); });

describe('witness: English is unchanged', () => {
  it('the toolbar, the palette and the help dialog render their original English strings', () => {
    render(<>{toolbar()}<DevicePalette /><HelpDialog open onOpenChange={() => undefined} /></>);
    expect(screen.getByText('Clear All')).toBeInTheDocument();
    expect(screen.getByTitle('Undo')).toBeInTheDocument();
    expect(screen.getByText('Drag to canvas')).toBeInTheDocument();
    expect(screen.getByText('Building a topology')).toBeInTheDocument();
  });
});

describe('French', () => {
  it('translates the toolbar when the user picks French, and switches back', () => {
    render(toolbar());
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'fr' } });
    expect(screen.getByText('Tout effacer')).toBeInTheDocument();
    expect(screen.getByTitle('Annuler')).toBeInTheDocument();
    expect(screen.getByLabelText('Nom du projet')).toBeInTheDocument();
    expect(screen.queryByText('Clear All')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'en' } });
    expect(screen.getByText('Clear All')).toBeInTheDocument();
  });

  it('is shared: one switch changes the palette and the help dialog too', () => {
    render(<>{toolbar()}<DevicePalette /><HelpDialog open onOpenChange={() => undefined} /></>);
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'fr' } });
    expect(screen.getByText('Glisser sur le canevas')).toBeInTheDocument();
    expect(screen.getByText('Commutateurs')).toBeInTheDocument();
    expect(screen.getByText('Construire une topologie')).toBeInTheDocument();
    expect(screen.getAllByText('Limité').length).toBeGreaterThan(0);
  });

  it('is remembered across a reload and announced on the document', () => {
    act(() => setLocale('fr'));
    expect(localStorage.getItem('ubuntu-sandbox.locale')).toBe('fr');
    expect(getLocale()).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
  });
});

describe('dialogs follow the language', () => {
  const dialogs = () => (
    <>
      <ConfirmDialog open onOpenChange={() => undefined} title="T" description="D" onConfirm={() => undefined} />
      <MessageDialog open onOpenChange={() => undefined} title="T" description="D" />
      <SaveTopologyDialog open onOpenChange={() => undefined} defaultName="Lab" onSave={() => undefined} />
      <OpenTopologyDialog open onOpenChange={() => undefined} onOpen={() => undefined} />
    </>
  );

  it('witness: English buttons and the English save caveat are unchanged', () => {
    render(dialogs());
    expect(screen.getAllByText('Cancel').length).toBeGreaterThan(0);
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Save topology')).toBeInTheDocument();
    expect(screen.getByText(TOPOLOGY_SAVE_CAVEATS)).toBeInTheDocument();
  });

  it('renders French labels, the French save caveat and the empty list message', () => {
    act(() => setLocale('fr'));
    render(dialogs());
    expect(screen.getAllByText('Annuler').length).toBeGreaterThan(0);
    expect(screen.getByText('Confirmer')).toBeInTheDocument();
    expect(screen.getByText('Enregistrer la topologie')).toBeInTheDocument();
    expect(screen.getByText(/Les sessions de terminal/)).toBeInTheDocument();
    expect(screen.getByText(/Aucune topologie enregistrée/)).toBeInTheDocument();
    expect(screen.queryByText(TOPOLOGY_SAVE_CAVEATS)).not.toBeInTheDocument();
  });
});

describe('the properties panel follows the language', () => {
  const selectNewDevice = () => {
    const device = useNetworkStore.getState().addDevice('linux-pc', 100, 100);
    act(() => useNetworkStore.getState().selectDevice(device.id));
  };

  it('witness: English text is unchanged for an empty selection and a selected device', () => {
    render(<PropertiesPanel />);
    expect(screen.getByText('Select a device or connection to view properties')).toBeInTheDocument();
    cleanup();
    selectNewDevice();
    render(<PropertiesPanel />);
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Power')).toBeInTheDocument();
  });

  it('shows French for an empty selection and for a selected device', () => {
    act(() => setLocale('fr'));
    render(<PropertiesPanel />);
    expect(screen.getByText(/Sélectionnez un équipement ou une connexion/)).toBeInTheDocument();
    cleanup();
    selectNewDevice();
    render(<PropertiesPanel />);
    expect(screen.getByText('Général')).toBeInTheDocument();
    expect(screen.getByText('Alimentation')).toBeInTheDocument();
    expect(screen.getByText('Allumé')).toBeInTheDocument();
    expect(screen.queryByText('General')).not.toBeInTheDocument();
  });
});

describe('the settings dialog and the clock controls follow the language', () => {
  const open = () => {
    installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
    render(<SettingsDialog open onOpenChange={() => undefined} />);
  };

  it('witness: English labels are unchanged', () => {
    open();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getAllByText('Simulation').length).toBeGreaterThan(0);
    expect(screen.getByText('Clock')).toBeInTheDocument();
    expect(screen.getByText('Advance every device by')).toBeInTheDocument();
    expect(screen.getByTitle('Advance every device by 1 min')).toBeInTheDocument();
  });

  it('renders French labels, titles and jump buttons', () => {
    act(() => setLocale('fr'));
    open();
    expect(screen.getByText('Paramètres')).toBeInTheDocument();
    expect(screen.getByText('Horloge')).toBeInTheDocument();
    expect(screen.getByText('Vitesse')).toBeInTheDocument();
    expect(screen.getByText('Avancer tous les équipements de')).toBeInTheDocument();
    expect(screen.getByTitle('Avancer tous les équipements de 1 j')).toBeInTheDocument();
    expect(screen.getByText('+1 j')).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('searches the text the user reads, not the English source', () => {
    act(() => setLocale('fr'));
    const filler = (id: string): SettingsSection => ({
      id, label: `Filler ${id}`, description: `Filler ${id} options`, icon: Timer, keywords: [], component: () => null,
    });
    const registry = new SettingsRegistry()
      .register(simulationSettingsSection)
      .register(filler('a')).register(filler('b')).register(filler('c')).register(filler('d'));
    installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
    render(<SettingsDialog open onOpenChange={() => undefined} registry={registry} />);
    fireEvent.change(screen.getByLabelText('Rechercher un paramètre'), { target: { value: 'infrastructure simulée' } });
    expect(screen.getByTestId('settings-nav-simulation')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-nav-a')).not.toBeInTheDocument();
    act(() => setLocale('en'));
    expect(screen.getByTestId('settings-no-match')).toBeInTheDocument();
  });
});

describe('the canvas, its devices and the interface selector follow the language', () => {
  it('witness: English canvas labels are unchanged', () => {
    render(<NetworkCanvas />);
    expect(screen.getByLabelText('Network topology canvas')).toBeInTheDocument();
    expect(screen.getByText('No devices yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
  });

  it('renders the French canvas, empty state and device action labels', () => {
    act(() => setLocale('fr'));
    const device = useNetworkStore.getState().addDevice('linux-pc', 100, 100);
    render(<NetworkCanvas />);
    expect(screen.getByLabelText('Canevas de la topologie réseau')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom avant')).toBeInTheDocument();
    act(() => useNetworkStore.getState().selectDevice(device.id));
    expect(screen.getByLabelText(`Supprimer ${device.name}`)).toBeInTheDocument();
    expect(screen.getByLabelText(`Relier ${device.name} à un autre équipement`)).toBeInTheDocument();
  });

  it('translates the interface selector header and cancel button', () => {
    act(() => setLocale('fr'));
    render(
      <InterfaceSelectorPopover
        deviceId="d1" deviceName="R1" interfaces={[]} connections={[]}
        position={{ x: 0, y: 0 }} isSource onSelect={() => undefined} onCancel={() => undefined}
      />,
    );
    expect(screen.getByText('Source : R1')).toBeInTheDocument();
    expect(screen.getByLabelText('Annuler le choix de l\'interface')).toBeInTheDocument();
  });
});

describe('the terminal taskbar follows the language', () => {
  const session = { device: { getName: () => 'R1', getType: () => 'router-cisco' } } as unknown as TerminalSession;
  const taskbar = () => (
    <TerminalTaskbar
      sessions={[['s1', session]]} minimizedIds={new Set()} onToggle={() => undefined}
      onClose={() => undefined} tileLayout="stack" onLayoutChange={() => undefined}
      focusedIndex={0} visibleCount={1} onFocusChange={() => undefined}
      desktopPeek={false} onToggleDesktop={() => undefined}
    />
  );

  it('witness: English layout and navigation titles are unchanged', () => {
    render(taskbar());
    expect(screen.getByTitle('Stack (Alt+S)')).toBeInTheDocument();
    expect(screen.getByTitle('Split Horizontal (Alt+H)')).toBeInTheDocument();
    expect(screen.getByText('Desktop')).toBeInTheDocument();
  });

  it('renders French layout names and the desktop toggle', () => {
    act(() => setLocale('fr'));
    render(taskbar());
    expect(screen.getByTitle('Pile (Alt+S)')).toBeInTheDocument();
    expect(screen.getByTitle('Division horizontale (Alt+H)')).toBeInTheDocument();
    expect(screen.getByText('Bureau')).toBeInTheDocument();
    expect(screen.getByLabelText('Disposer les terminaux : Grille (Alt+G)')).toBeInTheDocument();
  });
});

describe('the live statistics follow the language', () => {
  it('witness: English headings are unchanged', () => {
    const device = useNetworkStore.getState().addDevice('linux-pc', 100, 100);
    render(<LiveDeviceStats deviceId={device.id} />);
    expect(screen.getByText('Host stats')).toBeInTheDocument();
    expect(screen.getByText('ARP table')).toBeInTheDocument();
    expect(screen.getAllByText('(empty)').length).toBeGreaterThan(0);
  });

  it('renders French headings and counters; protocol names stay', () => {
    act(() => setLocale('fr'));
    const device = useNetworkStore.getState().addDevice('linux-pc', 100, 100);
    render(<LiveDeviceStats deviceId={device.id} />);
    expect(screen.getByText('Statistiques de l\'hôte')).toBeInTheDocument();
    expect(screen.getByText('Table de routage')).toBeInTheDocument();
    expect(screen.getByText('Table ARP')).toBeInTheDocument();
    expect(screen.getAllByText('(vide)').length).toBeGreaterThan(0);
    expect(screen.getByText(/Cache ARP : \d+ · NDP : \d+ · Routes : \d+/)).toBeInTheDocument();
  });

  it('says so in French when no device is selected', () => {
    act(() => setLocale('fr'));
    render(<LiveDeviceStats deviceId="nope" />);
    expect(screen.getByText('Aucun équipement sélectionné.')).toBeInTheDocument();
  });
});

describe('the cable accessible name', () => {
  const variables = {
    type: 'ethernet', source: 'R1', sourceInterface: 'Gi0/0', target: 'SW1', targetInterface: 'Gi0/1',
  };

  it('witness: English keeps the original sentence, with and without selection', () => {
    expect(translate('en', 'cable.label', { ...variables, state: translate('en', 'cable.up'), selected: '' }))
      .toBe('ethernet cable: R1 Gi0/0 to SW1 Gi0/1, link up');
    expect(translate('en', 'cable.label', {
      ...variables, state: translate('en', 'cable.down'), selected: translate('en', 'cable.selected'),
    })).toBe('ethernet cable: R1 Gi0/0 to SW1 Gi0/1, link down, selected');
  });

  it('is a French sentence that still says the state, not only the colour', () => {
    expect(translate('fr', 'cable.label', {
      ...variables, state: translate('fr', 'cable.down'), selected: translate('fr', 'cable.selected'),
    })).toBe('Câble ethernet : R1 Gi0/0 vers SW1 Gi0/1, lien coupé, sélectionné');
  });
});

describe('remaining accessible names', () => {
  it('translates the not-found page and keeps the English text as a witness', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { default: NotFound } = await import('@/pages/NotFound');
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    expect(screen.getByText('Oops! Page not found')).toBeInTheDocument();
    cleanup();
    act(() => setLocale('fr'));
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    expect(screen.getByText('Oups ! Page introuvable')).toBeInTheDocument();
    expect(screen.getByText('Retour à l\'accueil')).toBeInTheDocument();
  });

  it('formats the terminal command-line name in both languages', () => {
    expect(translate('en', 'terminalView.commandLine', { context: 'R1' })).toBe('Command line — R1');
    expect(translate('fr', 'terminalView.commandLine', { context: 'R1' })).toBe('Ligne de commande — R1');
    expect(translate('fr', 'terminalView.password')).toBe('Mot de passe');
  });
});

describe('the catalogues are complete', () => {
  it('French defines every key English defines, with no empty text', () => {
    const english = Object.keys(MESSAGES.en).sort();
    expect(Object.keys(MESSAGES.fr).sort()).toEqual(english);
    for (const key of english) {
      expect(MESSAGES.fr[key as keyof typeof MESSAGES.fr].trim(), key).not.toBe('');
    }
  });

  it('keeps the same placeholders in both languages', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const key of Object.keys(MESSAGES.en) as Array<keyof typeof MESSAGES.en>) {
      expect(placeholders(MESSAGES.fr[key]), key).toBe(placeholders(MESSAGES.en[key]));
    }
  });

  it('names every palette category and every device description in French', () => {
    for (const category of DEVICE_CATEGORIES) {
      expect(categoryLabel(category.id, 'fr', category.name), category.id).not.toBe(category.name);
      for (const device of category.devices) {
        expect(deviceTypeDescription(device.type, 'fr')).toBe(FRENCH_DEVICE_DESCRIPTIONS[device.type]);
      }
    }
  });
});
