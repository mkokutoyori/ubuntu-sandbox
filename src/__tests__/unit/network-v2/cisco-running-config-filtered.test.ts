/**
 * `show running-config` ne montre que ce que la session peut MODIFIER.
 *
 * Defaut mesure (audit §2.3, C5) : la configuration entiere etait rendue
 * a n'importe quel niveau des lors que la commande y etait deleguee. Un
 * operateur de niveau 5 lisait donc `snmp-server community <chaine> RO`
 * et l'ensemble des condenses `username … secret 5 $1$…`.
 *
 * Cisco documente ce filtrage comme une mesure de SECURITE, et nomme
 * lui-meme le contre-exemple : « The command should not display commands
 * above the user's current privilege level because of security
 * considerations. If so, commands such as `snmp-server community` could
 * be used to modify the current configuration of the router and gain
 * complete access. » Le simulateur divulguait exactement l'exemple cite.
 *
 * La consequence normale du filtrage est celle que la documentation
 * Cisco decrit aussi : sans delegation, la configuration parait VIDE.
 * C'est un cas de ce fichier, pas un defaut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Machine = CiscoRouter | CiscoSwitch;

async function jouer(m: Machine, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await m.executeCommand(c);
  return derniere;
}

const COMMUNAUTE = 'ChaineSnmpSecrete';

/** Une machine dont la configuration porte de quoi fuiter. */
async function labRouteur(delegations: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', MACAddress.generate());
  await jouer(r, [
    'enable', 'configure terminal',
    'hostname R1',
    'username zoe privilege 15 secret SecretDeZoe',
    `snmp-server community ${COMMUNAUTE} ro`,
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'shutdown', 'exit',
    'privilege exec level 5 show running-config',
    'privilege exec level 5 show',
    ...delegations,
    'end', 'disable', 'enable 5',
  ]);
  return r;
}

describe('C5 — la configuration est filtree par le niveau', () => {
  it('un niveau 5 ne lit ni la communaute SNMP ni les condenses locaux', async () => {
    const r = await labRouteur([]);
    expect(await r.executeCommand('show privilege')).toContain('level is 5');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).not.toContain(COMMUNAUTE);
    expect(cfg).not.toContain('username zoe');
    expect(cfg).not.toMatch(/secret 5 \$1\$/);
  });

  it('sans delegation, la configuration parait vide — comme sur IOS', async () => {
    const r = await labRouteur([]);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('Building configuration...');
    expect(cfg.trimEnd().endsWith('end')).toBe(true);
    expect(cfg).not.toContain('hostname R1');
  });

  it('ce qui est DELEGUE parait', async () => {
    const r = await labRouteur(['privilege configure level 5 hostname']);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('hostname R1');
    expect(cfg).not.toContain(COMMUNAUTE);
  });

  it('un bloc dont l en-tete est invisible disparait en entier', async () => {
    const r = await labRouteur([]);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).not.toContain('interface GigabitEthernet0/0');
    expect(cfg).not.toContain('ip address 10.0.0.1');
  });

  it('un bloc delegue parait, et ses lignes sont filtrees a leur tour', async () => {
    const r = await labRouteur([
      'privilege configure level 5 interface',
      'privilege interface level 5 ip address',
    ]);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('interface GigabitEthernet0/0');
    expect(cfg).toContain(' ip address 10.0.0.1 255.255.255.0');
    expect(cfg).not.toMatch(/^ shutdown$/m);
  });

  it('le filtrage vaut aussi pour `show startup-config`', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal',
      `snmp-server community ${COMMUNAUTE} ro`,
      'privilege exec level 5 show startup-config',
      'privilege exec level 5 show',
      'end', 'write memory', 'disable', 'enable 5',
    ]);
    expect(await r.executeCommand('show startup-config')).not.toContain(COMMUNAUTE);
  });

  it('sur le commutateur aussi', async () => {
    const sw = new CiscoSwitch('SW1', MACAddress.generate());
    await jouer(sw, [
      'enable', 'configure terminal',
      'username zoe privilege 15 secret SecretDeZoe',
      'privilege exec level 5 show running-config',
      'privilege exec level 5 show',
      'end', 'disable', 'enable 5',
    ]);
    const cfg = await sw.executeCommand('show running-config');
    expect(cfg).not.toContain('username zoe');
    expect(cfg).not.toContain('SecretDeZoe');
  });

  // ── Non-régression : le niveau 15 voit tout, inchangé ──────────────
  it('le niveau 15 lit la configuration entiere, inchangee', async () => {
    const r = await labRouteur([]);
    await jouer(r, ['disable', 'enable']);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain(COMMUNAUTE);
    expect(cfg).toContain('username zoe');
    expect(cfg).toContain('hostname R1');
    expect(cfg).toContain('interface GigabitEthernet0/0');
    expect(cfg).toMatch(/^ shutdown$/m);
  });

  it('le niveau 15 garde l en-tete, les separateurs et la fin', async () => {
    const r = await labRouteur([]);
    await jouer(r, ['disable', 'enable']);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('Building configuration...');
    expect(cfg).toMatch(/^Current configuration : \d+ bytes$/m);
    expect(cfg).toMatch(/^!$/m);
    expect(cfg.trimEnd().endsWith('end')).toBe(true);
  });
});
