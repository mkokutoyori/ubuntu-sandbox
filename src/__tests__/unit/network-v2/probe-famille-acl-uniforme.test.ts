import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPortNames(): string[];
}

const REFUS = /Invalid input|Incomplete command|Unknown command/;

async function enConfig(d: Cli): Promise<Cli> {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

function routeur(): Cli {
  const r = new CiscoRouter('R', 0, 0);
  r.powerOn();
  return r as unknown as Cli;
}

function catalyst(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  s.powerOn();
  return s as unknown as Cli;
}

const PLATEFORMES: ReadonlyArray<[string, () => Cli]> = [
  ['routeur', routeur],
  ['commutateur', catalyst],
];

describe('`ip access-list` nomme une liste, sur les DEUX plateformes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`ip access-list standard NOM\` entre dans le sous-mode`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('ip access-list standard BUREAU')).not.toMatch(REFUS);
      expect(await d.executeCommand('permit 192.168.1.0 0.0.0.255')).not.toMatch(REFUS);
    });

    it(`${nom} — \`ip access-list extended NOM\` aussi`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('ip access-list extended WEB')).not.toMatch(REFUS);
      expect(await d.executeCommand('permit tcp any any eq 80')).not.toMatch(REFUS);
    });

    it(`${nom} — un mot-cle inconnu est REFUSE`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('ip access-list zorglub NOM')).toMatch(REFUS);
    });

    it(`${nom} — \`remark\` est accepte dans le sous-mode`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip access-list standard BUREAU');

      expect(await d.executeCommand('remark liste du bureau')).not.toMatch(REFUS);
    });

    it(`${nom} — la liste PARAIT dans \`show ip access-lists\``, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip access-list standard BUREAU');
      await d.executeCommand('permit 192.168.1.0 0.0.0.255');
      await d.executeCommand('end');

      const vue = await d.executeCommand('show ip access-lists');
      expect(vue).toMatch(/BUREAU/);
      expect(vue).toMatch(/192\.168\.1\.0/);
    });

    it(`${nom} — et dans \`show access-lists\``, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip access-list standard BUREAU');
      await d.executeCommand('permit 192.168.1.0 0.0.0.255');
      await d.executeCommand('end');

      expect(await d.executeCommand('show access-lists')).toMatch(/BUREAU/);
    });

    it(`${nom} — \`no ip access-list standard NOM\` la retire`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip access-list standard BUREAU');
      await d.executeCommand('permit 192.168.1.0 0.0.0.255');
      await d.executeCommand('exit');
      await d.executeCommand('no ip access-list standard BUREAU');
      await d.executeCommand('end');

      expect(await d.executeCommand('show ip access-lists')).not.toMatch(/BUREAU/);
    });

    it(`${nom} — la liste se relit dans \`show running-config\``, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip access-list standard BUREAU');
      await d.executeCommand('permit 192.168.1.0 0.0.0.255');
      await d.executeCommand('end');

      const cfg = await d.executeCommand('show running-config');
      expect(cfg).toMatch(/ip access-list standard BUREAU/);
      expect(cfg).toMatch(/permit 192\.168\.1\.0 0\.0\.0\.255/);
    });

    it(`${nom} — \`ip access-group\` s applique a une interface`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip access-list standard BUREAU');
      await d.executeCommand('permit 192.168.1.0 0.0.0.255');
      await d.executeCommand('exit');
      await d.executeCommand(`interface ${d.getPortNames()[0]}`);

      expect(await d.executeCommand('ip access-group BUREAU in')).not.toMatch(REFUS);
    });

    it(`${nom} — \`ip access-list resequence\` existe`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('ip access-list standard BUREAU');
      await d.executeCommand('permit 192.168.1.0 0.0.0.255');
      await d.executeCommand('exit');

      expect(await d.executeCommand('ip access-list resequence BUREAU 10 10'))
        .not.toMatch(REFUS);
    });

    it(`${nom} — \`ip access-list ?\` annonce standard ET extended`, async () => {
      const d = await enConfig(faire());

      const aide = await d.executeCommand('ip access-list ?');
      expect(aide).toMatch(/standard/);
      expect(aide).toMatch(/extended/);
    });
  }
});

describe('une liste NUMEROTEE reste possible', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`access-list 10 permit\` alimente la meme vue`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('access-list 10 permit 10.0.0.0 0.0.0.255');
      await d.executeCommand('end');

      expect(await d.executeCommand('show ip access-lists')).toMatch(/10\.0\.0\.0/);
    });
  }
});
