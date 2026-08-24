/**
 * Le journal dit D'OU vient la modification, et le tampon ALERTE.
 *
 * Deux entrees `[journal]` de `TODO.md`, dont les DEUX reports sont faux :
 *
 *   — « le shell ne sait pas par quelle porte il est atteint, `FortiShell`
 *     est construit une fois par equipement » : `createManagementCli`
 *     en construit un PAR SESSION depuis la phase 14, et les trois portes
 *     portent deja leur `source` jusqu'a lui.
 *   — « ecrire trois evenements inventerait deux identifiants » : le
 *     report cherchait en 22xxx ; les trois existent en 32xxx.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. Une modification faite dans l'onglet porte `ui=jsconsole`.
 *   2. La meme faite en SSH porte `ui=ssh(<adresse>)` — c'est la seule
 *      chose qui distingue deux administrateurs dans une piste d'audit.
 *   3. En telnet, `ui=telnet(<adresse>)`.
 *   4. Le compte reste celui qui a ouvert la session, quelle que soit la
 *      porte.
 *   5. `full-first-warning-threshold` par defaut vaut 75, le deuxieme 90,
 *      le dernier 95.
 *   6. Franchir le premier seuil ecrit `0100032023`.
 *   7. Franchir le deuxieme ecrit `0100032042`, le dernier `0100032043`.
 *   8. Un franchissement s'annonce UNE FOIS : le tampon ne se remplit pas
 *      de ses propres alarmes.
 *   9. Redescendre sous le seuil REARME l'alerte.
 *  10. TEMOIN : un tampon large ne franchit rien — sans ce cas, une
 *      alerte ecrite a chaque enregistrement passerait pour une mesure.
 *
 * Discrimination (`git stash push -- src/network/`) : 7 cas sur 11
 * tombent. Les quatre qui passent des DEUX cotes sont nommes ici :
 *
 *   — « une modification faite dans l'onglet porte `ui=jsconsole` »
 *     passait AVANT, et c'est justement le defaut : la valeur etait
 *     ecrite en dur, donc ce cas est vrai pour la mauvaise raison. Ce
 *     sont ses voisins — SSH et telnet — qui prouvent le mecanisme, et
 *     lui garde le defaut par defaut.
 *   — « le compte reste celui qui a ouvert la session » : le champ
 *     `user` etait deja juste ; ce cas garde une non-regression.
 *   — « les trois seuils portent leurs defauts reels » : ils etaient
 *     deja rendus. Ce qui manquait est qu'ils soient LUS.
 *   — le TEMOIN, dont c'est l'objet de passer des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

const ADMIN_PASSWORD = 'SecretAudit1';
const POSTE = '192.168.1.50';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const poste = new LinuxPC('linux-pc', 'PC', 200, 0);
  poste.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, poste.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping ssh telnet', 'next', 'end',
    'config system admin', 'edit "admin"',
    `set password "${ADMIN_PASSWORD}"`, 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', `ip addr add ${POSTE}/24 dev eth0`]);

  return { fw, sh, poste };
}

function changements(fw: FortiGate): { ui: string; user: string; cfgpath: string }[] {
  return fw.getLogStore().all()
    .filter(record => record.fields.get('cfgpath') !== undefined)
    .map(record => ({
      ui: record.fields.get('ui') ?? '',
      user: record.fields.get('user') ?? '',
      cfgpath: record.fields.get('cfgpath') ?? '',
    }));
}

function alertes(fw: FortiGate): string[] {
  return fw.getLogStore().all()
    .filter(record => record.id.startsWith('010003'))
    .map(record => record.id);
}

/**
 * Une VRAIE session SSH depuis le poste, pas un `executeCommand` : c'est
 * la porte qui est mesuree, donc elle doit etre franchie.
 */
async function parSsh(poste: LinuxPC, ...lines: string[]): Promise<TerminalSession> {
  const host = new LinuxTerminalSession('h', poste);
  await host.init?.();

  host.setInput('ssh admin@192.168.1.1');
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(ADMIN_PASSWORD);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 10; i++) await tick();

  for (const line of lines) {
    const foreground = host.foreground;
    foreground.setInput(line);
    foreground.setInputBuf(line);
    host.handleKey(key('Enter'));
    for (let i = 0; i < 6; i++) await tick();
  }
  return host;
}

async function parTelnet(poste: LinuxPC, ...lines: string[]): Promise<TerminalSession> {
  const host = new LinuxTerminalSession('h', poste);
  await host.init?.();

  host.setInput('telnet 192.168.1.1');
  host.handleKey(key('Enter'));
  for (let i = 0; i < 12; i++) await tick();

  for (const reponse of ['admin', ADMIN_PASSWORD]) {
    if (host.currentInputMode.type === 'password') host.setPasswordBuf(reponse);
    else { host.foreground.setInput(reponse); host.foreground.setInputBuf(reponse); }
    host.handleKey(key('Enter'));
    for (let i = 0; i < 10; i++) await tick();
  }

  for (const line of lines) {
    const foreground = host.foreground;
    foreground.setInput(line);
    foreground.setInputBuf(line);
    host.handleKey(key('Enter'));
    for (let i = 0; i < 6; i++) await tick();
  }
  return host;
}

beforeEach(() => { Logger.reset(); });

describe('la piste d audit dit par quelle PORTE', () => {
  it('une modification faite dans l onglet porte `ui=jsconsole`', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config firewall address', 'edit "DEPUIS-ONGLET"',
      'set subnet 10.1.0.0 255.255.0.0', 'next', 'end');

    const trace = changements(fw).find(c => c.cfgpath === 'firewall.address');
    expect(trace?.ui).toBe('jsconsole');
  });

  it('la meme faite en SSH porte `ui=ssh(<adresse>)`', async () => {
    const { fw, poste } = await laboratoire();

    await parSsh(poste,
      'config firewall address', 'edit "DEPUIS-SSH"',
      'set subnet 10.2.0.0 255.255.0.0', 'next', 'end');

    const trace = changements(fw).find(c => c.cfgpath === 'firewall.address');
    expect(trace?.ui).toBe(`ssh(${POSTE})`);
  });

  it('le compte reste celui qui a ouvert la session', async () => {
    const { fw, poste } = await laboratoire();

    await parSsh(poste,
      'config firewall address', 'edit "QUI"',
      'set subnet 10.3.0.0 255.255.0.0', 'next', 'end');

    const trace = changements(fw).find(c => c.cfgpath === 'firewall.address');
    expect(trace?.user).toBe('admin');
  });

  it('en telnet, `ui=telnet(<adresse>)`', async () => {
    const { fw, poste } = await laboratoire();

    await parTelnet(poste,
      'config firewall address', 'edit "DEPUIS-TELNET"',
      'set subnet 10.6.0.0 255.255.0.0', 'next', 'end');

    const trace = changements(fw).find(c => c.cfgpath === 'firewall.address');
    expect(trace?.ui).toBe(`telnet(${POSTE})`);
  });

  it('deux portes donnent deux lignes DIFFERENTES', async () => {
    const { fw, sh, poste } = await laboratoire();

    run(sh, 'config firewall address', 'edit "A"',
      'set subnet 10.4.0.0 255.255.0.0', 'next', 'end');
    await parSsh(poste,
      'config firewall address', 'edit "B"',
      'set subnet 10.5.0.0 255.255.0.0', 'next', 'end');

    const portes = new Set(changements(fw).map(c => c.ui));
    expect(portes.size).toBeGreaterThan(1);
  });
});

describe('le tampon memoire alerte a chaque seuil', () => {
  it('les trois seuils portent leurs defauts reels', async () => {
    const { sh } = await laboratoire();

    const rendu = run(sh, 'show full-configuration log memory global-setting');
    expect(rendu).toContain('set full-first-warning-threshold 75');
    expect(rendu).toContain('set full-second-warning-threshold 90');
    expect(rendu).toContain('set full-final-warning-threshold 95');
  });

  it('franchir le PREMIER seuil ecrit `0100032023`', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log memory global-setting', 'set max-size 4096', 'end');

    remplir(fw, 0.8);

    expect(alertes(fw)).toContain('0100032023');
    expect(alertes(fw)).not.toContain('0100032042');
  });

  it('franchir le DEUXIEME puis le DERNIER ecrit les deux autres', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log memory global-setting', 'set max-size 4096', 'end');

    remplir(fw, 0.92);
    expect(alertes(fw)).toContain('0100032042');

    remplir(fw, 0.97);
    expect(alertes(fw)).toContain('0100032043');
  });

  it('un franchissement s annonce UNE FOIS', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log memory global-setting', 'set max-size 4096', 'end');

    remplir(fw, 0.8);
    remplir(fw, 0.82);

    const premieres = alertes(fw).filter(id => id === '0100032023');
    expect(premieres.length).toBe(1);
  });

  it('redescendre sous le seuil REARME l alerte', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log memory global-setting', 'set max-size 4096', 'end');

    remplir(fw, 0.8);
    fw.getLogStore().clear();
    remplir(fw, 0.8);

    expect(alertes(fw)).toContain('0100032023');
  });

  it('TEMOIN : un tampon large ne franchit rien', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log memory global-setting', 'set max-size 1048576', 'end');

    remplir(fw, 0.01);

    expect(alertes(fw)).toEqual([]);
  });
});

function remplir(fw: FortiGate, part: number): void {
  const store = fw.getLogStore();
  const cible = (store.getMaxBytes() ?? 0) * part;
  let garde = 0;
  while (store.usedBytes() < cible && garde++ < 5000) {
    store.append({
      at: 0, type: 'traffic', subtype: 'forward', level: 'notice',
      id: '0000000013', fields: { msg: 'remplissage' },
    });
  }
}
