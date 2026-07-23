/**
 * Rapport d'audit 04 (§5.9, item 5 du Top 10) — "Persistance startup vs
 * running incomplète et trompeuse" : `reload` faisait juste powerOff/powerOn
 * + reset du shell, laissant la config *objet* (interfaces, routes
 * statiques) survivre intégralement — l'inverse d'un vrai routeur qui
 * repart de la startup-config. Et `copy startup-config running-config` ne
 * ré-appliquait rien (`_restoreStartupConfig()` ne faisait que vérifier
 * qu'un snapshot existait).
 *
 * Ces tests figent le comportement corrigé : une config non sauvegardée
 * disparaît au reload ; une config sauvegardée (write memory / save) y
 * survit ; `copy start run` réapplique vraiment le texte sauvegardé.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

describe('Router config persistence — Cisco IOS', () => {
  it('an unsaved interface IP does not survive reload', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('end');

    await r.executeCommand('reload');
    await r.executeCommand('enable');

    const running = await r.executeCommand('show running-config');
    expect(running).not.toContain('10.0.0.1');
  });

  it('an interface IP saved with write memory survives reload', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('end');
    await r.executeCommand('write memory');

    await r.executeCommand('reload');
    await r.executeCommand('enable');

    const running = await r.executeCommand('show running-config');
    expect(running).toContain('ip address 10.0.0.1 255.255.255.0');
  });

  it('an unsaved static route does not survive reload, a saved one does', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('exit');
    await r.executeCommand('ip route 192.168.50.0 255.255.255.0 10.0.0.2');
    await r.executeCommand('end');
    await r.executeCommand('write memory');

    await r.executeCommand('configure terminal');
    await r.executeCommand('ip route 172.16.0.0 255.255.0.0 10.0.0.3');
    await r.executeCommand('end');

    await r.executeCommand('reload');
    await r.executeCommand('enable');

    const running = await r.executeCommand('show running-config');
    expect(running).toContain('ip route 192.168.50.0 255.255.255.0 10.0.0.2');
    expect(running).not.toContain('172.16.0.0');
  });

  it('copy startup-config running-config rejects when NVRAM is empty', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    const out = await r.executeCommand('copy startup-config running-config');
    expect(out).toContain('Non-volatile configuration memory is not present');
  });

  it('copy startup-config running-config re-applies a saved interface IP onto live state', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('end');
    await r.executeCommand('write memory');

    // Diverge the running config from what was saved.
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.99 255.255.255.0');
    await r.executeCommand('end');

    const copyOut = await r.executeCommand('copy startup-config running-config');
    expect(copyOut.toLowerCase()).toContain('[ok]');

    const running = await r.executeCommand('show running-config');
    expect(running).toContain('ip address 10.0.0.1 255.255.255.0');
  });
});

describe('Router config persistence — Huawei VRP', () => {
  it('an unsaved interface IP does not survive reboot', async () => {
    const r = new HuaweiRouter('R1', 0, 0);
    await r.executeCommand('system-view');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('quit');
    await r.executeCommand('quit');

    await r.executeCommand('reboot');

    const running = await r.executeCommand('display current-configuration');
    expect(running).not.toContain('10.0.0.1');
  });

  it('an interface IP saved with save survives reboot', async () => {
    const r = new HuaweiRouter('R1', 0, 0);
    await r.executeCommand('system-view');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    await r.executeCommand('save');

    await r.executeCommand('reboot');

    const running = await r.executeCommand('display current-configuration');
    expect(running).toContain('ip address 10.0.0.1 255.255.255.0');
  });
});
