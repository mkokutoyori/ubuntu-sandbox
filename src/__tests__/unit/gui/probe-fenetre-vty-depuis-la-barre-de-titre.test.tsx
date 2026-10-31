/** @vitest-environment jsdom */

/**
 * A chassis has one console, so the second window on a router or switch is a
 * virtual terminal line, and the title bar of the first window offers it.
 *
 * Measured before the fix: `TerminalManager.openTerminal(device, 'vty')` existed
 * (and a second double-click returns the open console), but nothing in the
 * interface could ask for the vty, so two simultaneous windows on a switch
 * became impossible from the UI.
 *
 * Discriminated with `git stash push -- src/components`: 2 of 3 cases fall
 * before the fix. The third is the WITNESS: a PC, which keeps several
 * consoles, never shows the button.
 */

import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const label = 'Open another window on a virtual terminal line';

async function modalOn(device: unknown, onNewVtyWindow: () => void) {
  const { CiscoSwitch } = await import('@/network/devices/CiscoSwitch');
  const { LinuxPC } = await import('@/network/devices/LinuxPC');
  const { LinuxTerminalSession } = await import('@/terminal/sessions/LinuxTerminalSession');
  const { createSessionForDevice } = await import('@/terminal/sessions/sessionFactory');
  const { TerminalModal } = await import('@/components/network/TerminalModal');
  const equipment = device === 'switch'
    ? new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0)
    : new LinuxPC('linux-pc', 'PC1', 0, 0);
  equipment.powerOn();
  const session = device === 'switch'
    ? createSessionForDevice(equipment, 's-vty')!
    : new LinuxTerminalSession('s-pc', equipment as never);
  render(<TerminalModal session={session} onClose={() => {}} onNewVtyWindow={onNewVtyWindow} />);
}

describe('the new VTY window button', () => {
  it('is offered on a switch, where the console is unique', async () => {
    await modalOn('switch', () => {});
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it('asks for another window when clicked', async () => {
    const asked = vi.fn();
    await modalOn('switch', asked);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('WITNESS: a PC keeps several consoles and shows no such button', async () => {
    await modalOn('pc', () => {});
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });
});
