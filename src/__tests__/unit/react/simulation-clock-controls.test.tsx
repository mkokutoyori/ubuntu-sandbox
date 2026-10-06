/**
 * @vitest-environment jsdom
 *
 * Mesure de depart : la barre d'outils n'offrait aucune commande du temps de la simulation.
 * `SimulationClockControls` expose pause/reprise, la vitesse et « avancer de » sur le
 * `SimulationClock` installe ; sans horloge installee (tests, hors application) il ne rend rien.
 * Les six cas tombent avant (le composant n'existait pas) ; « ne rend rien sans horloge » est
 * le temoin structurel : il passerait avec n'importe quelle barre d'outils vide.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { SimulationClockControls } from '@/components/network/SimulationClockControls';
import { formatSimulatedInstant } from '@/components/network/simulationClockFormat';
import { simulationDate } from '@/network/core/SystemClock';

function installManualClock() {
  let real = 0;
  let pump: (() => void) | null = null;
  const clock = installSimulationClock(new SimulationClock({
    realNow: () => real,
    startPump: (tick) => { pump = tick; return () => { pump = null; }; },
  }));
  return {
    clock,
    elapseReal: (ms: number) => { real += ms; pump?.(); },
  };
}

afterEach(() => { cleanup(); __resetSimulationClock(); });

describe('SimulationClockControls', () => {
  it('renders nothing when no clock is installed', () => {
    const { container } = render(<SimulationClockControls />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the simulated instant', () => {
    installManualClock();
    render(<SimulationClockControls />);
    expect(screen.getByTestId('simulation-instant').textContent).toBe(formatSimulatedInstant(simulationDate()));
  });

  it('resumes and pauses the clock from the toggle', () => {
    const { clock } = installManualClock();
    render(<SimulationClockControls />);
    fireEvent.click(screen.getByTestId('simulation-toggle'));
    expect(clock.getState().running).toBe(true);
    fireEvent.click(screen.getByTestId('simulation-toggle'));
    expect(clock.getState().running).toBe(false);
  });

  it('runs the simulation at the chosen speed', () => {
    const { clock, elapseReal } = installManualClock();
    render(<SimulationClockControls />);
    fireEvent.click(screen.getByTestId('simulation-speed-60'));
    expect(clock.getState()).toMatchObject({ running: true, speed: 60 });
    elapseReal(1_000);
    expect(clock.scheduler.now()).toBe(60_000);
  });

  it('advances the simulation by an hour and shows it', async () => {
    const { clock } = installManualClock();
    render(<SimulationClockControls />);
    const before = simulationDate().getTime();
    await act(async () => { fireEvent.click(screen.getByTestId('simulation-jump-3600000')); });
    await act(async () => { await clock.advance(0); });
    expect(simulationDate().getTime() - before).toBe(3_600_000);
    expect(screen.getByTestId('simulation-instant').textContent).toBe(formatSimulatedInstant(simulationDate()));
  });

  it('keeps the speed highlighted only while running', () => {
    installManualClock();
    render(<SimulationClockControls />);
    fireEvent.click(screen.getByTestId('simulation-speed-600'));
    expect(screen.getByTestId('simulation-speed-600').className).toContain('text-primary');
    fireEvent.click(screen.getByTestId('simulation-toggle'));
    expect(screen.getByTestId('simulation-speed-600').className).not.toContain('text-primary');
  });
});
