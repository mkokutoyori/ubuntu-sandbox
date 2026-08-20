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

/**
 * L'EN-TETE decrit ce qui est rendu, pas ce qui est cache.
 *
 * Defaut mesure sur une session de niveau 5 a qui `show running-config`
 * a ete deleguee : la vue annoncait `Current configuration : 861 bytes`
 * au-dessus d'un corps de 95 octets. Le nombre est celui de la
 * configuration COMPLETE, calcule avant le filtre — donc l'en-tete
 * decrit un document que la session n'a pas sous les yeux, et il rend
 * mesurable, au comptage d'octets pres, l'exacte quantite de
 * configuration qu'on lui cache. C'est le contraire de ce que le filtre
 * existe pour faire.
 */
describe('la taille annoncee est celle du corps rendu', () => {
  async function niveau5(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1');
    await jouer(r, [
      'enable', 'configure terminal',
      'username chef privilege 15 secret Chef15',
      'username arthur privilege 5 secret A5',
      'snmp-server community SECRETE RO',
      'privilege exec level 5 show running-config',
      'line console 0', 'login local', 'exit', 'end', 'exit',
    ]);
    await r.loginAs('arthur', 'A5');
    return r;
  }

  const taille = (texte: string): number => {
    const l = texte.split('\n');
    return new TextEncoder().encode(l.slice(4).join('\n')).length + 1;
  };
  const annonce = (texte: string): number =>
    Number(/Current configuration : (\d+) bytes/.exec(texte.split('\n')[2])?.[1] ?? -1);

  it('au niveau 5, l en-tete compte ce que le niveau 5 voit', async () => {
    const r = await niveau5();
    const vue = await r.executeCommand('show running-config');
    expect(annonce(vue)).toBe(taille(vue));
  });

  it('et ce nombre est plus petit que celui du niveau 15', async () => {
    const r = await niveau5();
    const vue5 = await r.executeCommand('show running-config');
    await r.executeCommand('enable', { passwordInput: '' });
    const r15 = new CiscoRouter('R2');
    await jouer(r15, [
      'enable', 'configure terminal',
      'username chef privilege 15 secret Chef15',
      'username arthur privilege 5 secret A5',
      'snmp-server community SECRETE RO',
      'privilege exec level 5 show running-config',
      'line console 0', 'login local', 'exit', 'end',
    ]);
    const vue15 = await r15.executeCommand('show running-config');
    expect(annonce(vue15)).toBe(taille(vue15));
    expect(annonce(vue5)).toBeLessThan(annonce(vue15));
  });

  it('non-regression : au niveau 15 rien ne change', async () => {
    const r = new CiscoRouter('R3');
    await jouer(r, ['enable', 'configure terminal', 'hostname CORE', 'end']);
    const vue = await r.executeCommand('show running-config');
    expect(annonce(vue)).toBe(taille(vue));
  });
});
