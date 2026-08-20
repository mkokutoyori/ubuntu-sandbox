import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privilegie(): Promise<Cli> {
  const device = nu();
  await device.executeCommand('enable');
  return device;
}

const VUES = [
  'show crypto isakmp profile',
  'show crypto ipsec sa interface',
  'show crypto ipsec security-association lifetime',
  'show crypto map interface',
  'show crypto ikev2 sa detailed',
  'show crypto ikev2 stats',
  'show crypto session detail',
  'show crypto gdoi',
  'show crypto eli',
  'show crypto engine connections active',
  'show crypto engine brief',
  'show crypto engine configuration',
  'show crypto pki certificates',
  'show crypto pki certificates verbose',
  'show crypto pki trustpoints',
  'show crypto key mypubkey rsa',
];

describe('les seize vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('l\'aide ne decrit plus un noeud par un de ses descendants', () => {
  it('`engine` n\'est plus « SNMP engine » — ce n\'est pas le meme moteur', async () => {
    const aide = (await privilegie()).cliHelp('show crypto ');
    const ligne = aide.split('\n').find(l => l.trim().startsWith('engine'))!;

    expect(ligne).not.toContain('SNMP');
    expect(ligne).toContain('crypto engine');
  });

  it('`connections` a une description, il n\'en avait aucune', async () => {
    const aide = (await privilegie()).cliHelp('show crypto engine ');
    const ligne = aide.split('\n').find(l => l.trim().startsWith('connections'));

    expect(ligne).toBeDefined();
    expect(ligne!.replace(/^\s*connections\s*/, '').trim().length).toBeGreaterThan(0);
  });

  it.each([
    ['show crypto ', 'pki', 'Show PKI information'],
    ['show crypto ', 'ikev2', 'Show IKEv2 information'],
    ['show crypto ', 'ipsec', 'Show IPsec information'],
    ['show crypto pki ', 'certificates', 'Show certificates'],
  ])('`%s?` decrit `%s` par lui-meme', async (frappe, mot, attendu) => {
    const ligne = (await privilegie()).cliHelp(frappe).split('\n')
      .find(l => l.trim().startsWith(mot))!;

    expect(ligne).toContain(attendu);
  });

  it('aucune branche de `show crypto ?` n\'est proposee sans description', async () => {
    const aide = (await privilegie()).cliHelp('show crypto ');

    for (const ligne of aide.split('\n').filter(l => l.trim() && !l.includes('<cr>'))) {
      const [mot, ...reste] = ligne.trim().split(/\s{2,}/);
      expect(reste.join(' ').trim(), mot).not.toBe('');
    }
  });
});

describe('`show crypto eli` rend les mots d\'IOS', () => {
  it('la ligne d\'etat n\'invente plus le mot « Layer »', async () => {
    const sortie = await (await privilegie()).executeCommand('show crypto eli');

    expect(sortie).toContain('Hardware Encryption : ACTIVE');
    expect(sortie).not.toContain('Hardware Encryption Layer');
  });

  it('et le compte nomme des moteurs MATERIELS', async () => {
    const sortie = await (await privilegie()).executeCommand('show crypto eli');

    expect(sortie).toContain('Number of hardware crypto engines');
  });

  it('les compteurs de sessions restent des mesures — le temoin', async () => {
    const sortie = await (await privilegie()).executeCommand('show crypto eli');

    expect(sortie).toMatch(/IKE Sessions\s+: \d+ active/);
    expect(sortie).toMatch(/IPSec Sessions\s+: \d+ active/);
  });
});

describe('ce que la migration ne devait pas changer', () => {
  it.each([
    ['show crypto pki trustpoints', 'No trustpoints configured'],
    ['show crypto key mypubkey rsa', '% No RSA key generated.'],
    ['show crypto map interface', 'No crypto maps configured'],
    ['show crypto isakmp profile', 'No active ISAKMP profile sessions'],
  ])('`%s` rend toujours `%s`', async (command, attendu) => {
    expect(await (await privilegie()).executeCommand(command)).toBe(attendu);
  });

  it.each([
    ['show crypto eng brief', 'show crypto engine brief'],
    ['show crypto pki trust', 'show crypto pki trustpoints'],
  ])('`%s` se complete en `%s`', async (frappe, attendu) => {
    expect((await privilegie()).cliTabCandidates(frappe)).toContain(attendu);
  });

  it('les vues deja au socle repondent encore', async () => {
    const device = await privilegie();

    for (const c of ['show crypto isakmp sa', 'show crypto ipsec sa', 'show crypto map']) {
      expect(await device.executeCommand(c), c).not.toContain('Invalid input');
    }
  });

  it('un mot inconnu est refuse', async () => {
    expect(await (await privilegie()).executeCommand('show crypto zorglub'))
      .toContain('Invalid input');
  });
});

describe('le commutateur n\'a pas de crypto, et n\'en gagne pas', () => {
  it.each(['show crypto eli', 'show crypto pki trustpoints', 'show crypto engine brief'])(
    '`%s` y reste refusee', async (command) => {
      const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
      await device.executeCommand('enable');

      expect(await device.executeCommand(command)).toContain('Invalid input');
    });
});
