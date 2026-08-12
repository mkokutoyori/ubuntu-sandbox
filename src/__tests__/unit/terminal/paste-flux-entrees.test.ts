/**
 * Le collage multi-lignes ne doit casser aucun flux d'entrée.
 *
 * Depuis que chaque ligne collée est livrée par le chemin d'une touche
 * Entrée, elle traverse TOUS les mécanismes d'invite du dépôt, et pas
 * seulement la ligne de commande : le plan d'interaction (`su`,
 * `passwd`, `enable`), le courtier d'entrées (`read`, `Read-Host`), la
 * pile SSH, la connexion console, le dialogue de ping étendu. Chacun
 * range sa réponse dans un buffer différent et la vide à sa façon.
 *
 * Ce fichier les exerce un par un avec un bloc collé, et vérifie les
 * trois choses qui peuvent casser : la valeur reçue, le vidage du
 * buffer entre deux invites (sinon la réponse suivante s'ajoute à la
 * précédente), et l'absence du secret dans l'historique.
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
const texte = (s: { lines: Array<{ text: string }> }) =>
  s.lines.map((l) => l.text).join('\n');

function poste(): { pc: LinuxPC; s: LinuxTerminalSession } {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  return { pc, s: new LinuxTerminalSession('t1', pc) };
}

async function consoleCisco(r: CiscoRouter): Promise<CiscoTerminalSession> {
  const s = new CiscoTerminalSession('t1', r);
  await s.init();
  for (let i = 0; i < 40 && s.isBooting; i++) await tick();
  return s;
}

describe('un plan d interaction à plusieurs étapes reçoit une réponse par ligne', () => {
  it('`passwd` lancé par root prend le nouveau mot de passe et sa confirmation', async () => {
    const { s } = poste();
    await s.pasteText('su - root\nadmin\npasswd\nNouveau#2026\nNouveau#2026\n');
    await tick();

    const out = texte(s);
    expect(out, 'une étape a été refusée : les réponses ne sont pas alignées')
      .not.toMatch(/do not match|Authentication token manipulation/);
    expect(out).toMatch(/updated successfully|password updated/i);
    expect(s.currentInputMode.type, 'une invite est restée ouverte').toBe('normal');
  }, 30_000);

  it('le secret ne finit pas dans l historique', async () => {
    const { s } = poste();
    await s.pasteText('su - root\nadmin\npasswd\nNouveau#2026\nNouveau#2026\n');
    await tick();
    expect(texte(s)).not.toContain('Nouveau#2026');
  }, 30_000);

  it('le buffer est vidé entre deux invites : pas de concaténation', async () => {
    const { s } = poste();
    // Si le buffer n'était pas vidé, la confirmation vaudrait
    // « Nouveau#2026Nouveau#2026 » et ne correspondrait plus.
    await s.pasteText('su - root\nadmin\npasswd\nNouveau#2026\nNouveau#2026\necho FINI\n');
    await tick();
    expect(texte(s)).toContain('FINI');
  }, 30_000);
});

describe('un bloc plus court que le dialogue laisse l invite ouverte', () => {
  it('`passwd` sans sa confirmation attend encore, et la ligne partielle est éditable', async () => {
    const { s } = poste();
    await s.pasteText('su - root\nadmin\npasswd\nNouveau#2026\npartiel');
    await tick();

    expect(s.currentInputMode.type,
      'le dialogue devrait attendre la confirmation').toBe('password');
    expect(s.getPasswordBuf(), 'la ligne non terminée doit rester saisie').toBe('partiel');
  }, 30_000);
});

describe('un bloc plus long que le dialogue exécute le reste', () => {
  it('les lignes qui suivent la dernière invite sont de vraies commandes', async () => {
    const { s } = poste();
    await s.pasteText('su - root\nadmin\necho APRES\n');
    await tick();
    expect(texte(s)).toContain('APRES');
    expect(s.currentInputMode.type).toBe('normal');
  }, 30_000);
});

describe('un mauvais mot de passe collé ne désaligne pas la suite', () => {
  it('le refus est visible et la ligne suivante n est pas prise pour le secret', async () => {
    const { s } = poste();
    await s.pasteText('su - root\nMAUVAIS\n');
    await tick();
    const out = texte(s);
    expect(out).toMatch(/Authentication failure|incorrect/i);
    expect(out).not.toContain('MAUVAIS');
  }, 30_000);
});

describe('la connexion console d un routeur se fait par le bloc collé', () => {
  it('nom d utilisateur puis mot de passe, et la configuration passe derrière', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('username admin privilege 15 secret Admin@2026');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('end');

    const s = await consoleCisco(r);
    expect(s.currentInputMode.type,
      'le laboratoire n a pas ouvert la connexion console').not.toBe('normal');

    await s.pasteText('admin\nAdmin@2026\nconfigure terminal\nhostname R-CONSOLE\nend\n');
    await tick();

    expect(r.getPrompt()).toContain('R-CONSOLE');
    expect(texte(s), 'le secret est passé dans l historique').not.toContain('Admin@2026');
  }, 30_000);
});

describe('le dialogue de ping étendu consomme le bloc question par question', () => {
  it('chaque réponse va à sa question, et la commande finale s exécute', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    const s = await consoleCisco(r);
    await s.pasteText('enable\nping\n');
    await tick();
    expect(s.currentInputMode.type,
      'le dialogue étendu ne s est pas ouvert').not.toBe('normal');

    // Protocole, cible, répétitions, taille, délai, commandes étendues,
    // balayage de tailles — sept questions, sept lignes.
    await s.pasteText('\n10.0.0.1\n2\n\n\n\n\n');
    await tick();

    const out = texte(s);
    expect(out).toContain('Sending 2, 100-byte ICMP Echos to 10.0.0.1');
    expect(s.currentInputMode.type, 'le dialogue est resté ouvert').toBe('normal');
  }, 30_000);
});

describe('le collage coupé ne touche à aucun flux', () => {
  it('un dialogue ouvert reçoit le bloc comme du texte, sans le soumettre', async () => {
    const { s } = poste();
    s.setInput('su - root');
    await s.dispatchEnter();
    expect(s.currentInputMode.type).toBe('password');

    s.definirCollageMultiligne(false);
    await s.pasteText('admin\necho FUITE\n');
    await tick();

    expect(s.currentInputMode.type, 'le bloc a été soumis malgré le réglage').toBe('password');
    expect(s.getPasswordBuf()).toBe('admin');
    expect(texte(s)).not.toContain('FUITE');
  }, 30_000);
});
