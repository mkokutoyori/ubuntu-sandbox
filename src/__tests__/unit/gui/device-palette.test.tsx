/** @vitest-environment jsdom */

/**
 * DevicePalette — disclosure of partially-simulated device types.
 *
 * Stubbed devices (mac-pc runs as Ubuntu Linux, firewall-* as Linux PCs,
 * access-point as a Hub) used to be presented exactly like fully-simulated
 * equipment; the user only discovered the substitution after wiring a lab
 * around them. The palette now badges them as "Limited".
 */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DevicePalette } from '@/components/network/DevicePalette';
import { DEVICE_CATEGORIES, isFullyImplemented } from '@/network';

/**
 * The count is DERIVED from the catalogue, never written down: a device
 * that graduates to a full simulation must change one flag, not a
 * constant in a test that nobody thinks to look at.
 */
const limitedInPalette = DEVICE_CATEGORIES
  .flatMap(category => category.devices)
  .filter(device => !isFullyImplemented(device.type));

describe('DevicePalette — limited-simulation badges', () => {
  it('marks every stubbed device type with a Limited badge', () => {
    render(<DevicePalette />);

    const badges = screen.getAllByText('Limited');
    expect(badges.length).toBe(limitedInPalette.length);
    expect(limitedInPalette.length).toBeGreaterThan(0);
  });

  it('explains the limitation in the badge tooltip', () => {
    render(<DevicePalette />);

    const badge = screen.getAllByText('Limited')[0];
    expect(badge).toHaveAttribute('title', expect.stringContaining('Limited simulation'));
  });

  it('does not badge fully-simulated devices', () => {
    render(<DevicePalette />);

    const linuxPcRow = screen.getByText('Linux PC').closest('[draggable]')!;
    expect(linuxPcRow.textContent).not.toContain('Limited');
  });
});

describe('isFullyImplemented classification', () => {
  it('flags devices that simulate a different OS or class as limited', () => {
    expect(isFullyImplemented('mac-pc')).toBe(false);        // runs Ubuntu
    expect(isFullyImplemented('firewall-cisco')).toBe(false); // Linux PC stub
    expect(isFullyImplemented('access-point')).toBe(false);   // Hub stub
    expect(isFullyImplemented('cloud')).toBe(false);          // Linux PC stub
  });

  it('keeps genuinely-simulated devices unflagged', () => {
    expect(isFullyImplemented('linux-pc')).toBe(true);
    expect(isFullyImplemented('windows-pc')).toBe(true);
    expect(isFullyImplemented('router-cisco')).toBe(true);
    expect(isFullyImplemented('switch-huawei')).toBe(true);
    expect(isFullyImplemented('firewall-fortinet')).toBe(true);
  });
});
