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
import { useNetworkStore } from '@/store/networkStore';
import { DEVICE_CATEGORIES } from '@/network';
import { getLocale, setLocale, categoryLabel, deviceTypeDescription } from '@/i18n';
import { MESSAGES, FRENCH_DEVICE_DESCRIPTIONS } from '@/i18n/messages';

const toolbar = () => (
  <Toolbar projectName="Lab" onProjectNameChange={() => undefined} hasDevices onClearAll={() => undefined} />
);

beforeEach(() => {
  localStorage.clear();
  setLocale('en');
  useNetworkStore.getState().clearAll();
});
afterEach(cleanup);

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
