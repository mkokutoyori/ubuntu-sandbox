/**
 * Le collage sur plusieurs lignes, tel qu'un vrai équipement le reçoit.
 *
 * Une console ne sait pas ce qu'est un collage : elle reçoit des
 * caractères, et chaque saut de ligne est une entrée. Deux conséquences
 * que le simulateur ne reproduisait pas, et qui sont TOUTE la
 * différence entre un bloc collé qui marche et un bloc collé qui ne
 * marche pas :
 *
 *  - une ligne qui ouvre une invite se fait répondre par la ligne
 *    SUIVANTE du bloc, puis le bloc continue. C'est ainsi qu'un
 *    `enable` suivi de son mot de passe passe dans un bloc collé ;
 *  - une ligne refusée n'interrompt pas la suite.
 *
 * Le collage s'arrêtait à la première invite et poussait le reste du
 * bloc, aplati, dans le buffer masqué. Le réglage `multiline paste`
 * permet de retrouver cette retenue — mais c'est une commodité
 * d'atelier, pas le comportement de référence, donc il est ACTIVÉ par
 * défaut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoTerminalSession } from '@/terminal/sessions';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function consoleCisco(routeur: CiscoRouter): Promise<CiscoTerminalSession> {
  const s = new CiscoTerminalSession('t1', routeur);
  await s.init();
  for (let i = 0; i < 40 && s.isBooting; i++) await tick();
  return s;
}

const texte = (s: { lines: Array<{ text: string }> }) =>
  s.lines.map((l) => l.text).join('\n');

describe('un bloc collé répond aux invites qu il ouvre', () => {
  it('`enable` suivi de son mot de passe passe, et la suite s exécute', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('enable secret Cisco@2026');
    await r.executeCommand('end');

    const s = await consoleCisco(r);
    // Le témoin : sans l'invite ouverte par `enable`, ce test ne
    // prouverait rien du chaînage.
    expect(s.currentInputMode.type).toBe('normal');

    await s.pasteText('enable\nCisco@2026\nconfigure terminal\nhostname R-COLLE\nend\n');
    await tick();

    expect(s.currentInputMode.type,
      'l invite est restée ouverte : le mot de passe n a pas été livré').toBe('normal');
    expect(r.getPrompt()).toContain('R-COLLE');
  }, 30_000);

  it('le mot de passe collé n est pas écrit en clair dans le journal', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('enable secret Cisco@2026');
    await r.executeCommand('end');

    const s = await consoleCisco(r);
    await s.pasteText('enable\nCisco@2026\nshow clock\n');
    await tick();

    expect(texte(s)).not.toContain('Cisco@2026');
  }, 30_000);
});

describe('une ligne refusée n interrompt pas le bloc', () => {
  it('les en-têtes d un `show run` collé sont refusés et la config passe', async () => {
    const r = new CiscoRouter('R1');
    const s = await consoleCisco(r);
    await s.pasteText([
      'enable',
      'configure terminal',
      'Building configuration...',
      'Current configuration : 2847 bytes',
      '!',
      'hostname R-APRES-ERREUR',
      'end',
      '',
    ].join('\n'));
    await tick();

    const out = texte(s);
    expect(out, 'les lignes d en-tête n ont pas été refusées')
      .toContain('% Invalid input detected');
    expect(r.getPrompt(), 'le bloc s est arrêté à la première erreur')
      .toContain('R-APRES-ERREUR');
  }, 30_000);
});

describe('le pageur consomme sa ligne et le bloc continue', () => {
  it('un `--More--` traversé par un collage ne l avale pas', async () => {
    const r = new CiscoRouter('R1');
    const s = await consoleCisco(r);
    await s.pasteText('enable\nterminal length 5\nshow running-config\n');
    await tick();
    expect(s.currentInputMode.type,
      'le laboratoire n a pas ouvert de pageur').toBe('pager');

    // Assez de sauts de ligne pour épuiser le pageur, puis une commande.
    await s.pasteText('\n'.repeat(400) + 'configure terminal\nhostname R-APRES-PAGEUR\nend\n');
    await tick();

    expect(r.getPrompt()).toContain('R-APRES-PAGEUR');
  }, 30_000);
});

describe('le réglage retient le bloc quand on le coupe', () => {
  it('par défaut il est actif — c est ce que fait une vraie machine', async () => {
    const pc = new LinuxPC('pc', 'PC1', 0, 0);
    pc.powerOn();
    expect(new LinuxTerminalSession('t', pc).collageMultiligneActif()).toBe(true);
  });

  it('coupé, rien ne part et le bloc reste éditable sur une seule ligne', async () => {
    const pc = new LinuxPC('pc', 'PC1', 0, 0);
    pc.powerOn();
    const s = new LinuxTerminalSession('t', pc);
    s.definirCollageMultiligne(false);

    await s.pasteText('echo alpha\necho beta\n');
    expect(texte(s)).not.toContain('alpha');
    expect(s.input).toBe('echo alpha echo beta ');
  });

  it('coupé, une invite de mot de passe ne garde que la première ligne', async () => {
    const pc = new LinuxPC('pc', 'PC1', 0, 0);
    pc.powerOn();
    const s = new LinuxTerminalSession('t', pc);
    s.definirCollageMultiligne(false);
    s.setInput('su - root');
    await s.dispatchEnter();
    expect(s.currentInputMode.type).toBe('password');

    await s.pasteText('secret\necho FUITE\n');
    expect(s.getPasswordBuf()).toBe('secret');
    expect(texte(s)).toMatch(/1 further line ignored/);
    expect(texte(s)).not.toContain('FUITE');
  });

  it('le réglage se bascule et se lit, comme le ghost text', () => {
    const pc = new LinuxPC('pc', 'PC1', 0, 0);
    pc.powerOn();
    const s = new LinuxTerminalSession('t', pc);
    expect(s.basculerCollageMultiligne()).toBe(false);
    expect(s.collageMultiligneActif()).toBe(false);
    expect(s.basculerCollageMultiligne()).toBe(true);
  });
});
