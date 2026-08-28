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
}

const REFUS = /Invalid input|Incomplete command|Unknown command/;

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

async function enConfig(d: Cli): Promise<Cli> {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

async function config(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

describe('`service password-encryption` se comporte pareil des deux cotes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la commande est acceptee`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('service password-encryption'))
        .not.toMatch(REFUS);
    });

    it(`${nom} — et parait dans la configuration`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('service password-encryption');

      expect(await config(d)).toMatch(/service password-encryption/);
    });

    it(`${nom} — le \`no\` la retire de la configuration`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('service password-encryption');
      await d.executeCommand('no service password-encryption');

      expect(await config(d)).not.toMatch(/^service password-encryption/m);
    });
  }
});

describe('`service sequence-numbers` se comporte pareil des deux cotes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — la commande est acceptee`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('service sequence-numbers')).not.toMatch(REFUS);
    });

    it(`${nom} — et parait dans la configuration`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('service sequence-numbers');

      expect(await config(d)).toMatch(/service sequence-numbers/);
    });
  }
});

describe('`service dhcp` suit la convention d IOS : seul l ARRET s ecrit', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — le defaut ne s ecrit PAS`, async () => {
      const d = await enConfig(faire());

      expect(await config(d)).not.toMatch(/^service dhcp/m);
    });

    it(`${nom} — mais \`no service dhcp\` s ecrit`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('no service dhcp');

      expect(await config(d)).toMatch(/no service dhcp/);
    });
  }
});

describe('`service timestamps` est accepte sous ses formes reelles', () => {
  const FORMES = [
    'service timestamps',
    'service timestamps log uptime',
    'service timestamps log datetime',
    'service timestamps log datetime msec',
    'service timestamps debug uptime',
    'service timestamps debug datetime msec',
  ];

  for (const [nom, faire] of PLATEFORMES) {
    for (const forme of FORMES) {
      it(`${nom} — \`${forme}\``, async () => {
        const d = await enConfig(faire());

        expect(await d.executeCommand(forme)).not.toMatch(REFUS);
      });
    }

    it(`${nom} — un mot-cle inconnu est REFUSE`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('service timestamps log zorglub'))
        .toMatch(REFUS);
    });

    it(`${nom} — la configuration reproduit ce qui a ete tape`, async () => {
      const d = await enConfig(faire());
      await d.executeCommand('service timestamps log uptime');

      expect(await config(d)).toMatch(/service timestamps log uptime/);
    });
  }
});

describe('l aide annonce la famille `service`', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — \`service ?\` annonce timestamps et password-encryption`, async () => {
      const d = await enConfig(faire());
      const aide = await d.executeCommand('service ?');

      expect(aide).toMatch(/timestamps/);
      expect(aide).toMatch(/password-encryption/);
    });

    it(`${nom} — \`service ?\` annonce dhcp`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('service ?')).toMatch(/dhcp/);
    });

    it(`${nom} — un mot-cle \`service\` inconnu est refuse`, async () => {
      const d = await enConfig(faire());

      expect(await d.executeCommand('service zorglub')).toMatch(REFUS);
    });
  }
});

describe('la famille `service` exige le mode CONFIGURATION', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — refusee avant \`configure terminal\``, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('service password-encryption'))
        .toMatch(REFUS);
    });
  }
});
