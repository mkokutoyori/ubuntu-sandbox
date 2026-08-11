/**
 * Les points du rapport de transcript qui restaient a traiter.
 *
 * Le lot precedent avait ferme la confusion console/vty/SSH et
 * l'historique partage. Restaient, dans le meme rapport :
 *
 *  §5  `history size` de LIGNE et `terminal history size` de SESSION
 *      sont deux reglages distincts, et le tampon ne doit jamais etre
 *      partage — or les trois magasins existaient sans etre relies.
 *  §9  `adminState`, `operState` et l'etat du protocole de ligne sont
 *      trois faits distincts, pas `no shutdown → up`.
 *  §10 `%SYS-5-CONFIG_I` employait « console » comme source generique
 *      au lieu de nommer la ligne d'ou vient la configuration.
 *  §13 la sortie de demarrage.
 *  §14 la table de licences.
 *  §15 numero de serie et adresse MAC de base doivent etre des
 *      proprietes de l'INSTANCE, sans quoi deux routeurs sont jumeaux.
 *
 * Plus deux points ouverts par le lot precedent lui-meme : le texte de
 * `%SSH-…-SSH2_SESSION`, qui n'etait celui d'aucune machine reelle, et
 * `local-user` du commutateur Huawei, qui n'atteignait aucun magasin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

async function routeur(nom = 'R1'): Promise<CiscoRouter> {
  const d = new CiscoRouter(nom, 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  return d;
}

// ── §5 — deux reglages distincts, un tampon par session ─────────────

describe('§5 — `history size` de ligne et `terminal history size` de session', () => {
  it('`history size` sous `line` est retenue et rendue', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('line console 0');
    await d.executeCommand('history size 40');
    await d.executeCommand('end');
    expect(await d.executeCommand('show running-config')).toContain('history size 40');
  }, 30_000);

  it('`history size` de la ligne borne VRAIMENT le tampon', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('line console 0');
    await d.executeCommand('history size 3');
    await d.executeCommand('end');
    for (const c of ['show clock', 'show version', 'show users', 'show privilege']) {
      await d.executeCommand(c);
    }
    const h = (await d.executeCommand('show history')).trim().split('\n');
    expect(h.length, 'le tampon est borne par la ligne').toBeLessThanOrEqual(3);
  }, 30_000);

  it('`terminal history size` l\'emporte pour la SESSION en cours', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('line console 0');
    await d.executeCommand('history size 2');
    await d.executeCommand('end');
    await d.executeCommand('terminal history size 5');
    for (const c of ['show clock', 'show version', 'show users', 'show privilege']) {
      await d.executeCommand(c);
    }
    // Cinq et non quatre : `terminal history size 5` entre elle-meme
    // dans l'historique, comme sur un vrai IOS — seules `show history`
    // et `clear history` en sont exclues.
    const h = (await d.executeCommand('show history')).trim().split('\n');
    expect(h.length, 'le reglage de session surclasse celui de la ligne').toBe(5);
  }, 30_000);

  it('`show terminal` rend la taille EFFECTIVE de la session', async () => {
    const d = await routeur();
    await d.executeCommand('terminal history size 42');
    expect(await d.executeCommand('show terminal')).toContain('42');
  }, 30_000);

  it('fermer la session rend la taille a celle de la ligne', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('line console 0');
    await d.executeCommand('history size 7');
    await d.executeCommand('end');
    await d.executeCommand('terminal history size 42');
    await d.executeCommand('exit');
    await d.executeCommand('enable');
    expect(await d.executeCommand('show terminal'),
      'le reglage de session ne survit pas a la session').toContain('7');
  }, 30_000);

  it('`terminal no history` supprime l\'historique de la session', async () => {
    const d = await routeur();
    await d.executeCommand('show clock');
    await d.executeCommand('terminal no history');
    await d.executeCommand('show version');
    expect((await d.executeCommand('show history')).trim()).toBe('');
  }, 30_000);
});

// ── §9 — trois etats distincts ──────────────────────────────────────

describe('§9 — administratif, operationnel et protocole de ligne', () => {
  it('sans cable, `no shutdown` ne monte PAS l\'interface', async () => {
    const d = await routeur();
    for (const c of ['configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']) {
      await d.executeCommand(c);
    }
    const out = await d.executeCommand('show interfaces GigabitEthernet0/0');
    expect(out, 'l\'etat administratif est monte').not.toContain('administratively down');
    expect(out, 'l\'etat operationnel ne l\'est pas').toMatch(/GigabitEthernet0\/0 is down/);
    expect(out, 'et le protocole de ligne non plus').toMatch(/line protocol is down/);
  }, 30_000);

  it('`shutdown` rend les trois etats a la fois', async () => {
    const d = await routeur();
    for (const c of ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']) {
      await d.executeCommand(c);
    }
    const out = await d.executeCommand('show interfaces GigabitEthernet0/0');
    expect(out).toMatch(/administratively down.*line protocol is down/);
  }, 30_000);
});

// ── §10 — la source de `%SYS-5-CONFIG_I` ────────────────────────────

describe('§10 — `%SYS-5-CONFIG_I` nomme la ligne d\'ou vient la configuration', () => {
  it('depuis la console, `by console`', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('end');
    const j = d.getLoggingConfig()!.render();
    expect(j).toContain('Configured from console by console');
    expect(j, 'pas de suffixe de ligne virtuelle').not.toMatch(/by console on vty/);
  }, 30_000);

  it('depuis une vty, `by <user> on vty0 (<ip>)`', async () => {
    const d = await routeur();
    const reg = (d as unknown as {
      getSshSessionRegistry(): { open(i: Record<string, unknown>): unknown };
    }).getSshSessionRegistry();
    reg.open({ user: 'alice', fromIp: '10.0.0.5', transport: 'ssh' });
    const shell = (d as unknown as {
      shell: { beginExecSession?: (n: number, u?: string) => void };
    }).shell;
    shell.beginExecSession?.(15, 'alice');
    await d.executeCommand('configure terminal');
    await d.executeCommand('end');
    expect(d.getLoggingConfig()!.render())
      .toContain('Configured from console by alice on vty0 (10.0.0.5)');
  }, 30_000);
});

// ── §13/§14 — demarrage et licences ─────────────────────────────────

describe('§13 et §14 — la sortie de demarrage et la table de licences', () => {
  it('le demarrage annonce le registre de configuration', async () => {
    const d = await routeur();
    expect(d.getBootSequence(), 'le registre gouverne le demarrage')
      .toMatch(/Configuration register is 0x2102/);
  }, 30_000);

  it('`show version` et le demarrage annoncent le MEME registre', async () => {
    const d = await routeur();
    const boot = /Configuration register is (\S+)/.exec(d.getBootSequence())?.[1];
    const version = /Configuration register is (\S+)/.exec(await d.executeCommand('show version'))?.[1];
    expect(boot, 'une seule machine, un seul registre').toBe(version);
  }, 30_000);

  it('`config-register` change ce que les DEUX vues annoncent', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('config-register 0x2142');
    await d.executeCommand('end');
    expect(await d.executeCommand('show version')).toContain('0x2142');
    expect(d.getBootSequence(), 'le demarrage lit la meme valeur').toContain('0x2142');
  }, 30_000);

  /**
   * `show license` liste les licences PAR FONCTIONNALITE ; la table des
   * PAQUETS TECHNOLOGIQUES qu'imprime le demarrage est celle de
   * `show license feature`. Deux commandes, deux tables — les confondre
   * ferait croire qu'un routeur sans `uc` n'a pas de ligne `uc`.
   */
  it('`show license feature` relit la table du demarrage', async () => {
    const d = await routeur();
    const lic = await d.executeCommand('show license feature');
    for (const ligne of ['ipbase', 'security', 'uc', 'data']) {
      expect(lic, ligne).toContain(ligne);
      expect(d.getBootSequence(), ligne).toContain(ligne);
    }
    expect(lic, 'la meme source, donc le meme texte')
      .toContain('Technology    Technology-package');
  }, 30_000);

  it('`show license` liste les licences par fonctionnalite', async () => {
    const d = await routeur();
    const lic = await d.executeCommand('show license');
    expect(lic).toContain('ipbasek9');
    expect(lic, 'une autre table que celle des paquets')
      .not.toContain('Technology-package');
  }, 30_000);
});

// ── §15 — l'identite est une propriete de l'INSTANCE ────────────────

describe('§15 — deux routeurs ne sont pas jumeaux', () => {
  it('deux routeurs portent deux numeros de serie differents', async () => {
    const a = await routeur('R1');
    const b = await routeur('R2');
    const sn = async (d: CiscoRouter) =>
      /Processor board ID (\S+)/.exec(await d.executeCommand('show version'))?.[1];
    const [x, y] = [await sn(a), await sn(b)];
    expect(x).toBeTruthy();
    expect(x, 'un numero de serie identifie un chassis').not.toBe(y);
  }, 30_000);

  it('le numero de serie est STABLE pour une meme machine', async () => {
    const d = await routeur();
    const sn = async () =>
      /Processor board ID (\S+)/.exec(await d.executeCommand('show version'))?.[1];
    expect(await sn()).toBe(await sn());
  }, 30_000);

  it('`show version` et `show inventory` nomment le meme chassis', async () => {
    const d = await routeur();
    const sn = /Processor board ID (\S+)/.exec(await d.executeCommand('show version'))?.[1];
    expect(await d.executeCommand('show inventory'),
      'deux vues, un seul chassis').toContain(sn!);
  }, 30_000);

  it('l\'adresse MAC de base est celle du premier port de la machine', async () => {
    const d = await routeur();
    const mac = d.getPorts()[0].getMAC().toString();
    expect(d.getBootSequence()).toContain(mac);
  }, 30_000);
});

// ── Les deux points laisses ouverts par le lot precedent ────────────

describe('le message SSH est celui d\'une vraie machine', () => {
  it('`%SSH-5-SSH2_SESSION` porte la formulation d\'IOS', async () => {
    const d = await routeur();
    const reg = (d as unknown as {
      getSshSessionRegistry(): { open(i: Record<string, unknown>): unknown };
    }).getSshSessionRegistry();
    reg.open({ user: 'alice', fromIp: '10.0.0.5', transport: 'ssh' });
    const j = d.getLoggingConfig()!.render();
    expect(j).toMatch(
      /%SSH-5-SSH2_SESSION: SSH2 Session request from 10\.0\.0\.5 \(tty = 0\) using crypto cipher '[^']+', hmac '[^']+' Succeeded/);
    expect(j, 'la formulation inventee a disparu').not.toContain('Session opened for');
  }, 30_000);

  it('le chiffre annonce est celui que la machine est configuree pour offrir', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('ip ssh server algorithm encryption aes256-ctr');
    await d.executeCommand('end');
    const reg = (d as unknown as {
      getSshSessionRegistry(): { open(i: Record<string, unknown>): unknown };
    }).getSshSessionRegistry();
    reg.open({ user: 'alice', fromIp: '10.0.0.5', transport: 'ssh' });
    expect(d.getLoggingConfig()!.render()).toContain("crypto cipher 'aes256-ctr'");
  }, 30_000);
});

describe('`local-user` du commutateur Huawei declare un vrai compte', () => {
  it('le compte atteint le magasin d\'identifiants', async () => {
    const d = new HuaweiSwitch('SW1', 24, 0, 0);
    d.powerOn();
    for (const c of ['system-view', 'aaa',
      'local-user admin password irreversible-cipher Huawei@123',
      'local-user admin privilege level 15', 'quit', 'quit']) {
      await d.executeCommand(c);
    }
    const compte = d.getCredentialStore().get('admin');
    expect(compte, 'le compte existe').toBeTruthy();
    expect(compte!.privilege).toBe(15);
  }, 30_000);

  it('le mot de passe est VERIFIABLE, pas remplace par des etoiles', async () => {
    const d = new HuaweiSwitch('SW1', 24, 0, 0);
    d.powerOn();
    for (const c of ['system-view', 'aaa',
      'local-user admin password irreversible-cipher Huawei@123', 'quit', 'quit']) {
      await d.executeCommand(c);
    }
    expect(d.getCredentialStore().authenticate('admin', 'Huawei@123')).toBe(true);
    expect(d.getCredentialStore().authenticate('admin', 'mauvais')).toBe(false);
  }, 30_000);

  it('`display users` nomme l\'operateur declare par `local-user`', async () => {
    const d = new HuaweiSwitch('SW1', 24, 0, 0);
    d.powerOn();
    for (const c of ['system-view', 'aaa',
      'local-user admin password irreversible-cipher Huawei@123', 'quit', 'quit']) {
      await d.executeCommand(c);
    }
    d.getCredentialStore().recordLoginSuccess('admin', 'console', 'password');
    expect(await d.executeCommand('display users')).toContain('admin');
  }, 30_000);

  it('`undo local-user` retire le compte du magasin', async () => {
    const d = new HuaweiSwitch('SW1', 24, 0, 0);
    d.powerOn();
    for (const c of ['system-view', 'aaa',
      'local-user admin password irreversible-cipher Huawei@123',
      'undo local-user admin', 'quit', 'quit']) {
      await d.executeCommand(c);
    }
    expect(d.getCredentialStore().get('admin')).toBeUndefined();
  }, 30_000);
});
