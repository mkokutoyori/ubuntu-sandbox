/**
 * @vitest-environment jsdom
 *
 * Les commandes du temps de la simulation (pause, vitesse, « avancer de ») encombraient l'en-tete
 * de l'application et en cassaient le dessin. Elles vivent maintenant dans la fenetre « Settings »,
 * ouverte par un seul bouton engrenage ; la barre d'outils n'en porte plus aucune.
 * Mesure de depart : la barre d'outils rendait `simulation-clock` ; 2 des 3 cas tombent avant (le
 * bouton Settings n'existait pas, la fenetre non plus) ; « la barre d'outils ne porte plus les
 * commandes du temps » tombe aussi avant. Le temoin est la fenetre qui n'affiche rien tant qu'elle
 * est fermee.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { Toolbar } from '@/components/network/Toolbar';
import { SettingsDialog } from '@/components/network/SettingsDialog';

afterEach(() => { cleanup(); __resetSimulationClock(); });

const toolbar = (onSettings?: () => void) => render(
  <Toolbar projectName="p" onProjectNameChange={() => undefined} onSettings={onSettings} />,
);

describe('simulation time lives in the Settings window', () => {
  it('the toolbar carries no time control, only a Settings button', () => {
    installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
    toolbar();
    expect(screen.queryByTestId('simulation-clock')).toBeNull();
    expect(screen.getByTitle('Settings')).toBeTruthy();
  });

  it('the Settings button asks for the window', () => {
    let opened = 0;
    toolbar(() => { opened += 1; });
    fireEvent.click(screen.getByTitle('Settings'));
    expect(opened).toBe(1);
  });

  it('the window shows the time controls when open, nothing when closed', () => {
    const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined }));
    const { rerender } = render(<SettingsDialog open={false} onOpenChange={() => undefined} />);
    expect(screen.queryByTestId('simulation-clock')).toBeNull();
    rerender(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByTestId('simulation-clock')).toBeTruthy();
    fireEvent.click(screen.getByTestId('simulation-toggle'));
    expect(clock.getState().running).toBe(true);
  });
});
