/**
 * @vitest-environment jsdom
 *
 * Keyboard/ARIA accessibility of the network canvas (rapport 09 audit).
 *
 * Before this, the canvas was 100% mouse/pointer-only: no way to add a
 * device without HTML5 drag-and-drop, no way to select/move/delete a
 * device or connection without a mouse, and zero ARIA roles/labels
 * anywhere in the canvas components.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useNetworkStore } from '@/store/networkStore';
import { DevicePalette } from '@/components/network/DevicePalette';
import { NetworkDevice } from '@/components/network/NetworkDevice';
import { NetworkCanvas } from '@/components/network/NetworkCanvas';

beforeEach(() => {
  useNetworkStore.getState().clearAll();
});

afterEach(() => {
  useNetworkStore.getState().clearAll();
});

describe('DevicePalette — keyboard/click device add (rapport 09)', () => {
  it('a device row is a real, accessibly-labelled button that adds a device on click', () => {
    render(<DevicePalette />);

    const before = useNetworkStore.getState().getDevices().length;
    const button = screen.getAllByRole('button', { name: /^Add .* to canvas/ })[0];
    expect(button.tagName).toBe('BUTTON');

    fireEvent.click(button);

    expect(useNetworkStore.getState().getDevices().length).toBe(before + 1);
  });

  it('category headers expose their expanded state', () => {
    render(<DevicePalette />);
    const header = screen.getAllByRole('button', { name: /.+/ }).find(
      (b) => b.hasAttribute('aria-expanded'),
    );
    expect(header).toBeTruthy();
    expect(header?.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('NetworkDevice — focusable, labelled, keyboard-operable (rapport 09)', () => {
  function addAndGetDevice() {
    const created = useNetworkStore.getState().addDevice('linux-pc', 100, 100);
    return useNetworkStore.getState().getDevices().find((d) => d.id === created.id)!;
  }

  it('exposes role=button, tabIndex=0, and a descriptive aria-label', () => {
    const device = addAndGetDevice();
    render(<NetworkDevice device={device} zoom={1} />);

    const node = screen.getByRole('button', { name: new RegExp(device.name) });
    expect(node.getAttribute('tabindex')).toBe('0');
    expect(node.getAttribute('aria-label')).toContain(device.name);
    expect(node.getAttribute('aria-label')).toContain('powered on');
  });

  it('Delete removes the device', () => {
    const device = addAndGetDevice();
    render(<NetworkDevice device={device} zoom={1} />);

    const node = screen.getByRole('button', { name: new RegExp(device.name) });
    fireEvent.keyDown(node, { key: 'Delete' });

    expect(useNetworkStore.getState().getDevices().find((d) => d.id === device.id)).toBeUndefined();
  });

  it('ArrowRight nudges the device position via moveDevice', () => {
    const device = addAndGetDevice();
    render(<NetworkDevice device={device} zoom={1} />);

    const node = screen.getByRole('button', { name: new RegExp(device.name) });
    fireEvent.keyDown(node, { key: 'ArrowRight' });

    const moved = useNetworkStore.getState().getDevices().find((d) => d.id === device.id)!;
    expect(moved.x).toBeGreaterThan(device.x);
  });

  it('focusing the device selects it (aria-pressed reflects selection)', () => {
    const device = addAndGetDevice();
    render(<NetworkDevice device={device} zoom={1} />);

    const node = screen.getByRole('button', { name: new RegExp(device.name) });
    expect(node.getAttribute('aria-pressed')).toBe('false');

    fireEvent.focus(node);

    expect(useNetworkStore.getState().selectedDeviceId).toBe(device.id);
  });

  it('quick-action buttons carry aria-labels independent of the title attribute', () => {
    const device = addAndGetDevice();
    useNetworkStore.getState().selectDevice(device.id);
    render(<NetworkDevice device={device} zoom={1} />);

    expect(screen.getByRole('button', { name: `Delete ${device.name}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Connect ${device.name} to another device` })).toBeTruthy();
  });
});

describe('NetworkCanvas — landmark role and live status region (rapport 09)', () => {
  it('exposes an application landmark and a polite status region', () => {
    render(<NetworkCanvas />);

    expect(screen.getByRole('application', { name: 'Network topology canvas' })).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('announces when a device is added', async () => {
    render(<NetworkCanvas />);
    const status = screen.getByRole('status');
    expect(within(status).queryByText(/added to canvas/)).toBeNull();

    fireEvent(window, new Event('resize')); // no-op, just exercises re-render path
    useNetworkStore.getState().addDevice('linux-pc', 50, 50);

    const announced = await screen.findByText(/added to canvas/);
    expect(announced).toBeTruthy();
  });

  it('zoom controls are accessibly labelled', () => {
    render(<NetworkCanvas />);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset zoom and pan' })).toBeTruthy();
  });
});
