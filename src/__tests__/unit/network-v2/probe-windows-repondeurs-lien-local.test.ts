/**
 * Un poste Windows pose du canevas repond a LLMNR, comme un poste Linux.
 *
 * Ecrit A L'AVEUGLE, apres une mesure faite sur le CHEMIN DE
 * L'APPLICATION : les equipements du canevas sont construits par
 * `createDevice`, qui n'appelle jamais `powerOn()` — un equipement nait
 * deja allume (`Equipment.isPoweredOn` vaut `true`). Or `WindowsPC`
 * n'appelait `syncLinkLocalResponders()` que depuis `powerOn()` et
 * depuis le crochet de changement du registre, jamais a la
 * construction ; `LinuxMachine`, elle, l'appelle dans son constructeur.
 *
 * Consequence mesuree entre deux machines du meme segment, montees
 * comme l'application les monte :
 *
 * ```
 * [linux] resolvectl query PC2   →  PC2: Name or service not known
 * [win]   netstat -an -p udp     →  (aucune ligne)
 * ```
 *
 * Le repondeur LLMNR et le repondeur mDNS d'un poste Windows
 * n'existaient donc PAS dans l'application, alors que les tests qui
 * appellent `powerOn()` a la main les voyaient tous les deux. Deux
 * plateformes qui repondent differemment a la meme question — quand
 * mes repondeurs commencent-ils ? — et c'est Windows qui avait tort.
 *
 * ── Ce qui n'est PAS un defaut, et qu'il ne fallait pas « corriger » ─
 *
 * Verifie avant d'y toucher, parce que la premiere lecture en faisait
 * un defaut : `ping PC2` et `getent hosts PC2` ne resolvent PAS par
 * LLMNR, la ou `resolvectl query PC2` le fait. C'est le comportement
 * d'un vrai Ubuntu : `libnss-resolve` n'y est PAS installe par defaut,
 * la ligne `hosts:` ne porte donc pas `resolve`, et la glibc s'en tient
 * a `nss-dns`. Seul `resolvectl`, qui parle directement au demon,
 * atteint LLMNR. De meme, `PC2.local` reste irresolu parce que le mDNS
 * global est a `no` — ce que `resolvectl status` affiche, et ce
 * qu'Ubuntu regle ainsi.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Mesure : 2 des 6 cas tombent contre l'etat d'avant, et c'est peu
 * parce que le correctif tient en une ligne. Les QUATRE autres sont
 * nommes plutot que laisses a decouvrir. Trois sont des TEMOINS de ce
 * qui ne doit PAS changer — le 5355 que Linux tenait deja, le mDNS
 * global a `no`, et `ping` qui ne passe pas par LLMNR — et ils existent
 * precisement parce que la premiere lecture voulait « corriger » les
 * deux derniers. Le quatrieme, « le reglage du registre reste vivant »,
 * passait avant pour une raison qui ne prouve rien : sans aucun
 * repondeur, 5355 etait absent des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const c of commands) last = await d.executeCommand(c);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

/** Le segment tel que l'APPLICATION le monte : `createDevice`, sans `powerOn`. */
async function segment() {
  const sw = createDevice('switch-cisco', 0, 0) as Equipment;
  const lin = createDevice('linux-pc', 0, 0) as Equipment;
  const win = createDevice('windows-pc', 0, 0) as Equipment;

  new Cable('c1').connect(
    lin.getPorts().find((p) => p.getName() === 'eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);

  const linux = lin as unknown as Cmd;
  const windows = win as unknown as Cmd;
  await taper(linux,
    'sudo ip addr add 10.0.0.1/24 dev eth0', 'sudo ip link set eth0 up');
  await taper(windows,
    'netsh interface ip set address "Ethernet0" static 10.0.0.2 255.255.255.0');

  return { linux, windows };
}

describe('les repondeurs de nom de lien existent des la construction', () => {
  it('le poste Windows tient 5355 et 5353', async () => {
    const { windows } = await segment();

    const sortie = await taper(windows, 'netstat -an -p udp');

    expect(sortie).toMatch(/^ +UDP +0\.0\.0\.0:5355 +\*:\*$/m);
    expect(sortie).toMatch(/^ +UDP +0\.0\.0\.0:5353 +\*:\*$/m);
  });

  it('et un voisin Linux le resout par LLMNR', async () => {
    const { linux, windows } = await segment();
    const nom = (await taper(windows, 'hostname')).trim();

    const sortie = await taper(linux, `resolvectl query ${nom}`);

    expect(sortie).toContain(`${nom}: 10.0.0.2`);
    expect(sortie).toContain('protocol LLMNR/IPv4');
  });

  it('le reglage du registre reste vivant apres la construction', async () => {
    const { windows } = await segment();

    await taper(windows, 'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT'
      + '\\DNSClient" /v EnableMulticast /t REG_DWORD /d 0 /f');
    const sortie = await taper(windows, 'netstat -an -p udp');

    expect(sortie).not.toMatch(/0\.0\.0\.0:5355/);
    expect(sortie).toMatch(/0\.0\.0\.0:5353/);
  });
});

describe('TEMOINS', () => {
  it('le poste Linux tenait deja son 5355', async () => {
    const { linux } = await segment();

    const sortie = await taper(linux, 'ss -lun');

    expect(sortie).toMatch(/0\.0\.0\.0:5355/);
  });

  it('le mDNS global de Linux reste a `no`, donc `.local` ne resout pas', async () => {
    const { linux, windows } = await segment();
    const nom = (await taper(windows, 'hostname')).trim();

    expect(await taper(linux, 'resolvectl status')).toContain('MulticastDNS setting: no');
    expect(await taper(linux, `resolvectl query ${nom}.local`))
      .toContain('Name or service not known');
  });

  it('`ping` ne resout pas par LLMNR, comme sur un Ubuntu sans nss-resolve', async () => {
    const { linux, windows } = await segment();
    const nom = (await taper(windows, 'hostname')).trim();

    expect(await taper(linux, 'cat /etc/nsswitch.conf')).toMatch(/^hosts: +files dns$/m);
    expect(await taper(linux, `ping -c 1 ${nom}`)).toContain('Name or service not known');
  });
});
