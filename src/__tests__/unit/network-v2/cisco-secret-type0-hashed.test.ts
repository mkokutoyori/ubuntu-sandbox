/**
 * `secret 0 <mot>` decrit une SAISIE en clair, pas un STOCKAGE en clair.
 *
 * Defaut mesure (audit §2.4, C6) : le secret d'une vue saisi
 * `secret 0 nocpw` etait rendu `secret 0 nocpw` dans la configuration,
 * sur la MEME machine et dans le MEME fichier ou un `username … secret`
 * etait hache. La mesure a montre que le defaut depassait les vues : le
 * chiffre `0` etait range comme un ALGORITHME (`plain`) par les trois
 * commandes de la famille — `enable secret`, `username … secret` et le
 * `secret` d'une vue — alors qu'il decrit le format de ce qu'on TAPE.
 *
 * Sur IOS, un `secret` est irreversible par definition : `enable secret 0
 * cisco` ressort en `enable secret 5 $1$…`. Seul un `password` — la
 * famille REVERSIBLE, qui a son propre rendu — reste en clair tant que
 * `service password-encryption` n'est pas pose, et les cas de
 * non-regression le fixent.
 *
 * Limite assumee et ecrite plutot que tue : le secret reste stocke en
 * CLAIR en memoire et n'est hache qu'au rendu — c'est deja le cas de la
 * forme nue `secret <mot>` depuis toujours, et changer le modele de
 * stockage est un autre chantier. Ce qui fuyait, et qui est referme,
 * c'est la configuration.
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

async function jouer(d: CiscoRouter | CiscoSwitch, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await d.executeCommand(c);
  return derniere;
}

const cfg = (d: CiscoRouter | CiscoSwitch) => d.executeCommand('show running-config');

describe('C6 — un `secret` saisi en type 0 est rendu hache', () => {
  it('le secret d une VUE ne parait pas en clair', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view NOC', 'secret 0 MotDePasseEnClair',
      'commands exec include show version', 'exit', 'end',
    ]);
    const c = await cfg(r);
    expect(c).not.toContain('MotDePasseEnClair');
    expect(c).toMatch(/^ secret 5 \$1\$/m);
  });

  it('et il ouvre toujours la vue', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view NOC', 'secret 0 MotDePasseEnClair',
      'commands exec include show version', 'exit', 'end',
    ]);
    await r.executeCommand('enable view NOC', { passwordInput: 'MotDePasseEnClair' });
    expect(await r.executeCommand('show parser view')).toBe("Current view is 'NOC'");
  });

  it('`enable secret 0 <mot>` ne parait pas en clair', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, ['enable', 'configure terminal', 'enable secret 0 SecretActivation', 'end']);
    const c = await cfg(r);
    expect(c).not.toContain('SecretActivation');
    expect(c).toMatch(/^enable secret 5 \$1\$/m);
  });

  it('et il ouvre toujours le mode privilegie', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, ['enable', 'configure terminal', 'enable secret 0 SecretActivation', 'end', 'disable']);
    await r.executeCommand('enable', { passwordInput: 'SecretActivation' });
    expect(await r.executeCommand('show privilege')).toContain('level is 15');
  });

  it('`enable secret level N 0 <mot>` ne parait pas en clair', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, ['enable', 'configure terminal', 'enable secret level 7 0 SecretPalier', 'end']);
    const c = await cfg(r);
    expect(c).not.toContain('SecretPalier');
    expect(c).toMatch(/^enable secret level 7 5 \$1\$/m);
  });

  it('`username X secret 0 <mot>` ne parait pas en clair', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, ['enable', 'configure terminal', 'username zoe secret 0 SecretDeZoe', 'end']);
    const c = await cfg(r);
    expect(c).not.toContain('SecretDeZoe');
    expect(c).toMatch(/^username zoe .*secret 5 \$1\$/m);
  });

  it('sur le commutateur aussi', async () => {
    const sw = new CiscoSwitch('SW1', MACAddress.generate());
    await jouer(sw, [
      'enable', 'configure terminal',
      'enable secret 0 SecretActivation',
      'username zoe secret 0 SecretDeZoe',
      'end',
    ]);
    const c = await cfg(sw);
    expect(c).not.toContain('SecretActivation');
    expect(c).not.toContain('SecretDeZoe');
  });

  it('la configuration rendue est REJOUABLE — le secret reste verifiable', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, ['enable', 'configure terminal', 'enable secret 0 SecretActivation', 'end']);
    const ligne = (await cfg(r)).split('\n').find((l) => l.startsWith('enable secret '))!;

    const r2 = new CiscoRouter('R2', MACAddress.generate());
    await jouer(r2, ['enable', 'configure terminal', ligne, 'end', 'disable']);
    await r2.executeCommand('enable', { passwordInput: 'SecretActivation' });
    expect(await r2.executeCommand('show privilege')).toContain('level is 15');
  });

  // ── Non-régression : la famille REVERSIBLE n'est pas touchée ───────
  it('`username X password 0 <mot>` reste en clair sans service password-encryption', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, ['enable', 'configure terminal', 'username zoe password 0 MotReversible', 'end']);
    expect(await cfg(r)).toContain('password 0 MotReversible');
  });

  it('`service password-encryption` chiffre toujours la famille reversible', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal',
      'username zoe password 0 MotReversible',
      'service password-encryption', 'end',
    ]);
    const c = await cfg(r);
    expect(c).not.toContain('MotReversible');
    expect(c).toMatch(/password 7 /);
  });

  it('un condense DEJA calcule passe tel quel, sous son propre type', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal',
      'enable secret 5 $1$abcd$0123456789012345678901',
      'end',
    ]);
    expect(await cfg(r)).toContain('enable secret 5 $1$abcd$0123456789012345678901');
  });

  it('la forme NUE reste hachee comme avant', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, ['enable', 'configure terminal', 'enable secret SecretNu', 'end']);
    const c = await cfg(r);
    expect(c).not.toContain('SecretNu');
    expect(c).toMatch(/^enable secret 5 \$1\$/m);
  });
});
