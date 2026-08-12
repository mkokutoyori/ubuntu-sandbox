/**
 * Ce qu'une deconnexion fait a l'equipement, et ce qu'un changement de
 * compte fait a une session deja ouverte.
 *
 * Deux defauts mesures avant ce fichier :
 *
 * 1. **Eteindre la machine ne fermait AUCUNE session.** Un routeur hors
 *    tension listait toujours ses sessions SSH, et les gardait apres
 *    rallumage — donc `show users` decrivait des connexions d'avant le
 *    redemarrage, et leurs lignes restaient prises.
 * 2. **`username X <mot inconnu>` etait accepte en silence.** La boucle
 *    d'analyse ignorait tout mot qu'elle ne reconnaissait pas, si bien
 *    que `username carl disable` et `username carl lock` — qui
 *    n'existent sur aucun IOS — repondaient sans un mot et ne faisaient
 *    rien. Un operateur croyait avoir desactive un compte qui restait
 *    ouvert.
 *
 * Le reste etait juste, et les cas qui le pincent le disent : couper une
 * ligne ferme vraiment, libere vraiment, et se journalise ; et un
 * changement de compte ne tue PAS une session en cours, ce qui est le
 * comportement d'IOS et non un manque.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

interface Reg {
  open(i: Record<string, unknown>): { id: string; lineIndex: number } | null;
  list(): readonly { id: string; user: string; lineIndex: number }[];
  hasFreeLine(): boolean;
  close(id: string, reason?: string): void;
}
const reg = (d: CiscoRouter): Reg =>
  (d as unknown as { getSshSessionRegistry(): Reg }).getSshSessionRegistry();

interface Store {
  authenticate(n: string, p: string): boolean;
  get(n: string): { privilege: number } | undefined;
}
const comptes = (d: CiscoRouter): Store =>
  (d as unknown as { getCredentialStore(): Store }).getCredentialStore();

async function routeur(...cfg: string[]): Promise<CiscoRouter> {
  const d = new CiscoRouter('R1', 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  if (cfg.length > 0) {
    await d.executeCommand('configure terminal');
    for (const c of cfg) await d.executeCommand(c);
    await d.executeCommand('end');
  }
  return d;
}

const ouvrir = (d: CiscoRouter, user: string, ip: string) =>
  reg(d).open({ user, fromIp: ip, localPort: 22, peerPort: 1 });

describe('une deconnexion agit sur la machine', () => {
  it('`clear line` ferme la session, pas seulement l\'affichage', async () => {
    const d = await routeur();
    ouvrir(d, 'admin', '10.0.0.1');
    // On coupe la ligne d'un AUTRE : la derniere session ouverte est
    // celle que la machine tient pour courante, et IOS refuse de couper
    // la ligne courante (docs/PRD-Lignes-Terminal.md §2).
    ouvrir(d, 'bob', '10.0.0.2');
    expect(reg(d).list()).toHaveLength(2);
    expect(await d.executeCommand('show users')).toContain('10.0.0.1');

    await d.executeCommand('clear line vty 0');
    expect(reg(d).list().map((s) => s.user), 'la session doit avoir disparu')
      .toEqual(['bob']);
    expect(await d.executeCommand('show users'), 'et la vue doit suivre')
      .not.toContain('10.0.0.1');
  }, 30_000);

  it('la ligne liberee redevient utilisable', async () => {
    const d = await routeur();
    for (let i = 0; i < 5; i++) ouvrir(d, `u${i}`, `10.0.0.${i}`);
    expect(reg(d).hasFreeLine()).toBe(false);
    await d.executeCommand('clear line vty 2');
    expect(reg(d).hasFreeLine()).toBe(true);
    expect(ouvrir(d, 'nouveau', '10.0.0.9'), 'une connexion doit repasser').toBeTruthy();
  }, 30_000);

  it('la deconnexion laisse une trace nominative', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    ouvrir(d, 'admin', '192.168.1.55');
    ouvrir(d, 'bob', '10.0.0.2');
    await d.executeCommand('clear line vty 0');
    const j = await d.executeCommand('show logging');
    expect(j).toContain('%SYS-6-LOGOUT: User admin has exited tty session 0(192.168.1.55)');
  }, 30_000);

  /**
   * Le defaut principal : une machine eteinte gardait ses sessions, et
   * les rendait encore apres rallumage.
   */
  it('eteindre la machine ferme TOUTES les sessions', async () => {
    const d = await routeur();
    ouvrir(d, 'admin', '10.0.0.1');
    ouvrir(d, 'bob', '10.0.0.2');
    expect(reg(d).list()).toHaveLength(2);

    d.powerOff();
    expect(reg(d).list(), 'une machine eteinte n\'a plus de session').toHaveLength(0);
  }, 30_000);

  it('apres rallumage, aucune session d\'avant ne subsiste', async () => {
    const d = await routeur();
    ouvrir(d, 'admin', '10.0.0.1');
    d.powerOff();
    d.powerOn();
    expect(reg(d).list()).toHaveLength(0);
    expect(reg(d).hasFreeLine(), 'toutes les lignes sont libres').toBe(true);
    expect(await d.executeCommand('show users')).not.toContain('10.0.0.1');
  }, 30_000);

  it('les lignes sont toutes reutilisables apres un redemarrage', async () => {
    const d = await routeur();
    for (let i = 0; i < 5; i++) ouvrir(d, `u${i}`, `10.0.0.${i}`);
    expect(reg(d).hasFreeLine()).toBe(false);
    d.powerOff();
    d.powerOn();
    for (let i = 0; i < 5; i++) {
      expect(ouvrir(d, `apres${i}`, `10.1.0.${i}`), `ligne ${i}`).toBeTruthy();
    }
  }, 30_000);
});

describe('un changement de compte atteint la machine', () => {
  it('le nouveau mot de passe remplace l\'ancien', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    expect(comptes(d).authenticate('admin', 'Admin@2025')).toBe(true);
    await d.executeCommand('configure terminal');
    await d.executeCommand('username admin privilege 15 secret NOUVEAU@2025');
    await d.executeCommand('end');
    expect(comptes(d).authenticate('admin', 'Admin@2025'), 'l\'ancien ne doit plus ouvrir').toBe(false);
    expect(comptes(d).authenticate('admin', 'NOUVEAU@2025')).toBe(true);
  }, 30_000);

  it('le changement de privilege est pris en compte', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    expect(comptes(d).get('admin')?.privilege).toBe(15);
    await d.executeCommand('configure terminal');
    await d.executeCommand('username admin privilege 5 secret Admin@2025');
    await d.executeCommand('end');
    expect(comptes(d).get('admin')?.privilege).toBe(5);
  }, 30_000);

  it('`no username` supprime le compte et ferme la porte', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    await d.executeCommand('configure terminal');
    await d.executeCommand('no username admin');
    await d.executeCommand('end');
    expect(comptes(d).get('admin')).toBeUndefined();
    expect(comptes(d).authenticate('admin', 'Admin@2025')).toBe(false);
    expect(await d.executeCommand('show running-config')).not.toContain('username admin');
  }, 30_000);

  /**
   * La contrepartie, et c'est le comportement d'IOS et non un manque :
   * changer ou supprimer un compte ne TUE PAS une session en cours. Un
   * administrateur qui se retire son propre compte garde sa session
   * jusqu'a ce qu'il la quitte — c'est pour cela que `clear line`
   * existe. Sans ce cas on aurait pu « ameliorer » le correctif en
   * fermant les sessions a chaque `no username`, ce qui est faux.
   */
  it('mais une session EN COURS n\'est pas tuee par la suppression', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    ouvrir(d, 'admin', '10.0.0.1');
    await d.executeCommand('configure terminal');
    await d.executeCommand('no username admin');
    await d.executeCommand('end');
    expect(reg(d).list(), 'la session survit — il faut `clear line` pour la couper')
      .toHaveLength(1);
    ouvrir(d, 'bob', '10.0.0.2');
    await d.executeCommand('clear line vty 0');
    expect(reg(d).list().map((s) => s.user)).toEqual(['bob']);
  }, 30_000);

  it('un changement de mot de passe ne coupe pas la session non plus', async () => {
    const d = await routeur('username admin privilege 15 secret Admin@2025');
    ouvrir(d, 'admin', '10.0.0.1');
    await d.executeCommand('configure terminal');
    await d.executeCommand('username admin privilege 15 secret AUTRE@2025');
    await d.executeCommand('end');
    expect(reg(d).list()).toHaveLength(1);
  }, 30_000);
});

describe('les mots-cles de `username` sont ceux d\'IOS', () => {
  const VRAIS = [
    'username a privilege 15 secret Abcdef@1',
    'username b nopassword',
    'username c password 0 Abcdef@1',
    'username d secret 5 $1$abc$defghijklmnopqrstuvw',
    'username e algorithm-type sha256 secret Abcdef@1',
    'username f access-class 10',
    'username g autocommand show users',
    'username h nohangup',
    'username i noescape',
    'username j one-time secret Abcdef@1',
  ];
  it.each(VRAIS)('`%s` est acceptee', async (cmd) => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    const r = await d.executeCommand(cmd);
    await d.executeCommand('end');
    expect(r, cmd).not.toContain('% Invalid input');
  }, 30_000);

  /**
   * Ni `disable` ni `lock` n'existent sur un IOS — la liste reelle des
   * mots-cles de `username` ne les contient pas. Ils etaient acceptes
   * en silence, donc un operateur croyait avoir desactive un compte qui
   * restait parfaitement ouvert.
   */
  const INVENTES = ['username carl disable', 'username carl lock', 'username carl expire'];
  it.each(INVENTES)('`%s` est REFUSEE', async (cmd) => {
    const d = await routeur('username carl privilege 15 secret Carl@2025');
    await d.executeCommand('configure terminal');
    const r = await d.executeCommand(cmd);
    await d.executeCommand('end');
    expect(r, cmd).toContain('% Invalid input');
  }, 30_000);

  it('un mot refuse ne modifie PAS le compte', async () => {
    const d = await routeur('username carl privilege 15 secret Carl@2025');
    await d.executeCommand('configure terminal');
    await d.executeCommand('username carl disable');
    await d.executeCommand('end');
    expect(comptes(d).authenticate('carl', 'Carl@2025'),
      'le compte reste tel qu\'il etait').toBe(true);
    expect(comptes(d).get('carl')?.privilege).toBe(15);
  }, 30_000);
});
