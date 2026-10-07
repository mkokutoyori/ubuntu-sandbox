/**
 * @vitest-environment jsdom
 *
 * La fenetre « Settings » ne devait pas etre construite pour une seule categorie : elle recevra
 * d'autres reglages que le temps. Elle est donc pilotee par un registre de sections (une section =
 * une entree de navigation + un panneau), et la categorie « Simulation » n'en est que la premiere.
 * Mesure de depart : la fenetre rendait en dur le seul bloc du temps — ajouter une categorie
 * demandait de modifier la fenetre. Sur l'etat d'avant, le module `@/components/settings` n'existe
 * pas : les 7 cas tombent (importation impossible), y compris le temoin « la fenetre par defaut
 * affiche toujours les commandes du temps sous Simulation », dont l'equivalent de non-regression
 * (`settings-simulation-time`) passe des deux cotes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Palette, Terminal, Wrench, Globe, Gauge } from 'lucide-react';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { SettingsDialog, SettingsRegistry, type SettingsSection } from '@/components/settings';

afterEach(() => { cleanup(); __resetSimulationClock(); });

const section = (id: string, label: string, keywords: string[] = []): SettingsSection => ({
  id, label, description: `${label} options`, icon: Palette, keywords,
  component: () => <div data-testid={`panel-${id}`}>{label} panel</div>,
});

describe('the registry', () => {
  it('lists sections in registration order and refuses a duplicate identifier', () => {
    const registry = new SettingsRegistry().register(section('a', 'Alpha')).register(section('b', 'Beta'));
    expect(registry.list().map((s) => s.id)).toEqual(['a', 'b']);
    expect(() => registry.register(section('a', 'Again'))).toThrow('already registered');
  });

  it('searches by label, description and keywords', () => {
    const registry = new SettingsRegistry()
      .register(section('a', 'Appearance', ['theme']))
      .register(section('t', 'Terminal', ['font']));
    expect(registry.search('theme').map((s) => s.id)).toEqual(['a']);
    expect(registry.search('TERMINAL options').map((s) => s.id)).toEqual(['t']);
    expect(registry.search('nothing like it')).toEqual([]);
    expect(registry.search('terminal').map((s) => s.id)).toEqual(['t']);
    expect(registry.search('  ').length).toBe(2);
  });
});

describe('the window', () => {
  it('witness: the default window shows the clock under Simulation', () => {
    installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByTestId('settings-nav-simulation').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('simulation-clock')).toBeTruthy();
  });

  it('shows one panel at a time and switches with the navigation', () => {
    const registry = new SettingsRegistry().register(section('a', 'Alpha')).register(section('b', 'Beta'));
    render(<SettingsDialog open onOpenChange={() => undefined} registry={registry} />);
    expect(screen.getByTestId('panel-a')).toBeTruthy();
    expect(screen.queryByTestId('panel-b')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-nav-b'));
    expect(screen.getByTestId('panel-b')).toBeTruthy();
    expect(screen.queryByTestId('panel-a')).toBeNull();
    expect(screen.getByTestId('settings-nav-b').getAttribute('aria-current')).toBe('page');
  });

  it('opens on the requested section', () => {
    const registry = new SettingsRegistry().register(section('a', 'Alpha')).register(section('b', 'Beta'));
    render(<SettingsDialog open onOpenChange={() => undefined} registry={registry} initialSectionId="b" />);
    expect(screen.getByTestId('panel-b')).toBeTruthy();
  });

  it('offers a search only once there are enough categories, and filters the navigation', () => {
    const few = new SettingsRegistry().register(section('a', 'Alpha'));
    const { unmount } = render(<SettingsDialog open onOpenChange={() => undefined} registry={few} />);
    expect(screen.queryByLabelText('Search settings')).toBeNull();
    unmount();

    const many = [Palette, Terminal, Wrench, Globe, Gauge].reduce(
      (registry, _icon, index) => registry.register(section(`s${index}`, `Section ${index}`, index === 3 ? ['proxy'] : [])),
      new SettingsRegistry(),
    );
    render(<SettingsDialog open onOpenChange={() => undefined} registry={many} />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'proxy' } });
    expect(screen.queryByTestId('settings-nav-s0')).toBeNull();
    expect(screen.getByTestId('settings-nav-s3').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('panel-s3')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('settings-no-match')).toBeTruthy();
  });
});
