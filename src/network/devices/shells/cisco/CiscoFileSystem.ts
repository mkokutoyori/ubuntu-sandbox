/**
 * Le système de fichiers d'un IOS — `flash:` et `nvram:`.
 *
 * `show flash:` existait, mais rendait un tableau **figé** calculé depuis
 * le profil châssis : rien n'était stocké, donc rien ne pouvait être
 * supprimé, lu ou vérifié. `dir`, `more`, `delete`, `verify` répondaient
 * tous `% Invalid input detected at '^' marker.` (audit 11, §4.1).
 *
 * Ce n'est pas un détail de confort : c'est le socle d'un chapitre entier
 * de la certification — gérer les images, sauvegarder et restaurer une
 * configuration — et surtout de **la récupération de mot de passe**,
 * l'exercice le plus enseigné du lot :
 *
 *     Router(config)# config-register 0x2142   ← ignorer nvram: au boot
 *     Router# reload
 *     Router# copy startup-config running-config
 *
 * Le registre de configuration est donc modélisé pour de vrai, avec le
 * seul bit qui compte : **0x40 met le démarrage en « ignorer la
 * configuration de démarrage »**. C'est ce qui distingue `0x2102`
 * (normal) de `0x2142` (récupération), et c'est la raison d'être de la
 * manipulation.
 *
 * Ce qui n'est PAS modélisé, et pourquoi : le contenu réel d'une image
 * IOS. Les fichiers portent un nom, une taille et une date ; `more` sur
 * une image binaire répond ce que répond le vrai devant du binaire, et
 * `verify` calcule sa somme sur ce que le fichier contient ici — un
 * contenu de configuration pour `config.text`, rien pour une image. Une
 * somme MD5 inventée sur une image inexistante serait une fausseté
 * vérifiable.
 */

import { CISCO_HARDWARE_PROFILES, type CiscoChassisProfile } from './CiscoCommonShow';

export interface CiscoFile {
  name: string;
  /** Contenu textuel quand il y en a un (`config.text`) ; sinon absent. */
  content?: string;
  size: number;
  /** `-rwx` pour un fichier, `drwx` pour un répertoire. */
  directory?: boolean;
  modified: Date;
}

const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * `Mar 01 2024 00:00:00` — la date telle que `dir` la met.
 *
 * Elle lisait `getHours()`, c'est-à-dire l'heure LOCALE de la machine
 * qui fait tourner le navigateur : sous un fuseau à +1, un fichier écrit
 * par `archive config` portait 13:43:30 pendant que `show clock` du même
 * équipement disait 12:43:30. Elle lit l'horloge de l'ÉQUIPEMENT, comme
 * toutes les autres vues de date d'IOS.
 */
function fmtDate(d: Date, offsetMin: number): string {
  const local = new Date(d.getTime() + offsetMin * 60_000);
  const deux = (n: number) => String(n).padStart(2, '0');
  return `${MOIS[local.getUTCMonth()]} ${deux(local.getUTCDate())} `
    + `${local.getUTCFullYear()} ${deux(local.getUTCHours())}`
    + `:${deux(local.getUTCMinutes())}:${deux(local.getUTCSeconds())}`;
}

/** Le registre de configuration d'usine. */
export const CONFIG_REGISTER_DEFAUT = 0x2102;
/** Le bit qui fait ignorer `nvram:` au démarrage — d'où `0x2142`. */
export const BIT_IGNORER_NVRAM = 0x40;

export const NVRAM_PRIVATE_CONFIG_BYTES = 5;

const NVRAM_RESERVE_BYTES = 8;

export class CiscoFileSystem {
  private readonly flash = new Map<string, CiscoFile>();
  private readonly totalBytes: number;
  private readonly nvramBytes: number;
  private configRegister = CONFIG_REGISTER_DEFAUT;
  /** `boot system flash:<image>`, dans l'ordre de déclaration. */
  private readonly bootSystem: string[] = [];

  constructor(
    private readonly profile: CiscoChassisProfile,
    private readonly now: () => Date = () => new Date(),
    private readonly offsetMin: () => number = () => 0,
  ) {
    const hw = CISCO_HARDWARE_PROFILES[profile];
    const naissance = new Date(Date.UTC(2024, 2, 1));
    this.totalBytes = hw.flashTotalBytes;
    this.nvramBytes = hw.nvramKB * 1024 - NVRAM_RESERVE_BYTES;
    this.flash.set(hw.flashImage, { name: hw.flashImage, size: hw.flashImageSize, modified: naissance });
    for (const f of hw.extraFlashFiles) {
      this.flash.set(f.name, { name: f.name, size: f.size, modified: naissance });
    }
  }

  // ── Fichiers ────────────────────────────────────────────────────

  list(): CiscoFile[] {
    return [...this.flash.values()];
  }

  get(name: string): CiscoFile | undefined {
    return this.flash.get(stripFs(name));
  }

  exists(name: string): boolean {
    return this.flash.has(stripFs(name));
  }

  /**
   * Le contenu d'un fichier, ou `null`. Ce système de fichiers savait
   * ÉCRIRE et lister, jamais relire : une archive de configuration
   * existait donc sur `flash:` sans qu'aucune vue puisse en lire le
   * texte, ce qui rendait un diff impossible à calculer.
   */
  read(name: string): string | null {
    return this.flash.get(stripFs(name))?.content ?? null;
  }

  write(name: string, content: string): void {
    const n = stripFs(name);
    this.flash.set(n, { name: n, content, size: content.length, modified: this.now() });
  }

  /** Rend vrai si le fichier existait. */
  /**
   * `mkdir` — un répertoire est une entrée de taille nulle marquée
   * `drwx`, comme `dir` la rend déjà pour `archive/`.
   */
  makeDirectory(name: string): void {
    const clef = stripFs(name).replace(/\/+$/, '');
    if (clef === '' || this.flash.has(clef)) return;
    this.flash.set(clef, { name: clef, size: 0, directory: true, modified: this.now() });
  }

  /** `rmdir` — refuse un répertoire non vide, comme IOS. */
  removeDirectory(name: string): 'ok' | 'absent' | 'non-vide' {
    const clef = stripFs(name).replace(/\/+$/, '');
    const entree = this.flash.get(clef);
    if (!entree || !entree.directory) return 'absent';
    for (const autre of this.flash.keys()) {
      if (autre !== clef && autre.startsWith(`${clef}/`)) return 'non-vide';
    }
    this.flash.delete(clef);
    return 'ok';
  }

  remove(name: string): boolean {
    return this.flash.delete(stripFs(name));
  }

  freeBytes(): number {
    const utilises = [...this.flash.values()].reduce((s, f) => s + f.size, 0);
    return Math.max(0, this.totalBytes - utilises);
  }

  capacityBytes(): number { return this.totalBytes; }

  nvramTotalBytes(): number { return this.nvramBytes; }

  nvramFreeBytes(startupSize: number): number {
    return Math.max(0, this.nvramBytes - startupSize - NVRAM_PRIVATE_CONFIG_BYTES);
  }

  // ── Registre de configuration & séquence de démarrage ───────────

  getConfigRegister(): number { return this.configRegister; }

  /**
   * La valeur qui prendra effet au PROCHAIN démarrage.
   *
   * IOS distingue les deux, et la distinction est le cœur de la
   * récupération de mot de passe : `config-register 0x2142` ne change
   * rien à la machine qui tourne, il prépare le prochain démarrage —
   * d'où `Configuration register is 0x2102 (will be 0x2142 at next
   * reload)`. Les confondre ferait ignorer `nvram:` immédiatement, ce
   * qu'aucun IOS ne fait, et rendrait l'exercice incompréhensible.
   */
  private configRegisterPending: number | null = null;

  getPendingConfigRegister(): number | null { return this.configRegisterPending; }

  /** `0x2102`, `0x2142`, … Rend faux si la valeur n'est pas lisible. */
  setConfigRegister(text: string): boolean {
    const m = /^0x([0-9a-f]{1,4})$/i.exec(text.trim());
    if (!m) return false;
    const valeur = parseInt(m[1], 16);
    this.configRegisterPending = valeur === this.configRegister ? null : valeur;
    return true;
  }

  /** Le démarrage adopte la valeur préparée. */
  applyPendingConfigRegister(): void {
    if (this.configRegisterPending !== null) {
      this.configRegister = this.configRegisterPending;
      this.configRegisterPending = null;
    }
  }

  /** La ligne qu'`show version` et `show bootvar` écrivent toutes deux. */
  renderConfigRegisterLine(): string {
    const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;
    const base = `Configuration register is ${hex(this.configRegister)}`;
    return this.configRegisterPending === null
      ? base
      : `${base} (will be ${hex(this.configRegisterPending)} at next reload)`;
  }

  /**
   * Vrai quand le registre demande d'ignorer `nvram:` au démarrage — le
   * `0x2142` de la récupération de mot de passe.
   */
  ignoreStartupConfig(): boolean {
    return (this.configRegister & BIT_IGNORER_NVRAM) !== 0;
  }

  addBootSystem(image: string): void {
    if (!this.bootSystem.includes(image)) this.bootSystem.push(image);
  }

  removeBootSystem(image?: string): void {
    if (image === undefined) { this.bootSystem.length = 0; return; }
    const i = this.bootSystem.indexOf(image);
    if (i >= 0) this.bootSystem.splice(i, 1);
  }

  getBootSystem(): readonly string[] { return this.bootSystem; }

  // ── Rendus ──────────────────────────────────────────────────────

  /** `dir [flash:]` — la vue par défaut, celle qu'on tape en premier. */
  /**
   * `dir [flash:[<sous-répertoire>/]]`.
   *
   * L'argument ne servait qu'à écrire l'en-tête : `dir flash:archive/`
   * listait la RACINE, donc l'image IOS et le fichier de configuration
   * d'usine, qui ne sont pas dans `archive/`. Sur une séquence de
   * collecte de preuves c'est une réponse fausse à une question précise —
   * l'auditeur demande ce qu'il y a dans le répertoire d'archives et on
   * lui montre autre chose. Le nom rendu est relatif au répertoire
   * listé, comme sur une vraie machine.
   */
  renderDir(fs = 'flash:'): string {
    const prefixe = sousRepertoire(fs);
    const lignes = [`Directory of ${fs.endsWith('/') ? fs : fs + '/'}`, ''];
    let i = 1;
    for (const f of this.flash.values()) {
      if (prefixe !== '' && !f.name.startsWith(prefixe)) continue;
      const affiche = prefixe === '' ? f.name : f.name.slice(prefixe.length);
      const mode = f.directory ? 'drwx' : '-rwx';
      lignes.push(`${String(i).padStart(5)}  ${mode}  ${String(f.size).padStart(11)}`
        + `  ${fmtDate(f.modified, this.offsetMin())}  ${affiche}`);
      i++;
    }
    lignes.push('', `${this.totalBytes} bytes total (${this.freeBytes()} bytes free)`);
    return lignes.join('\n');
  }

  /** `show flash:` — même contenu, la mise en forme historique. */
  renderShowFlash(): string {
    const lignes = ['Directory of flash:/', ''];
    let i = 1;
    for (const f of this.flash.values()) {
      lignes.push(`    ${i}  -rwx     ${String(f.size).padStart(8, ' ')}`
        + `   ${fmtDate(f.modified, this.offsetMin())}  ${f.name}`);
      i++;
    }
    lignes.push('', `${this.totalBytes} bytes total (${this.freeBytes()} bytes free)`);
    return lignes.join('\n');
  }

  /**
   * `show bootvar` / `show boot`.
   *
   * Les deux plateformes ont deux vues DIFFERENTES, et rendre celle du
   * routeur sur un Catalyst annoncait un registre de configuration que
   * `show version` de la meme machine dementait (`0xF`) et qu'aucune
   * commande ne pouvait regler. Un Catalyst de configuration fixe decrit
   * son amorcage par des chemins de fichiers — c'est `flash:config.text`
   * que la manoeuvre de recuperation renomme, la ou un routeur pose
   * 0x2142.
   */
  renderBootvar(): string {
    const chaine = this.bootSystem.length > 0
      ? this.bootSystem.map((i) => `flash:${i}`).join(';')
      : '';
    if (this.profile === 'router-isr2911') {
      return [
        `BOOT variable = ${chaine}`,
        'CONFIG_FILE variable does not exist',
        'BOOTLDR variable does not exist',
        this.renderConfigRegisterLine(),
      ].join('\n');
    }
    const largeur = 20;
    const champ = (nom: string, valeur: string) => `${nom.padEnd(largeur)}: ${valeur}`;
    return [
      champ('BOOT path-list', chaine),
      champ('Config file', 'flash:/config.text'),
      champ('Private Config file', 'flash:/private-config.text'),
      champ('Enable Break', this.enableBreak ? 'yes' : 'no'),
      champ('Manual Boot', this.manualBoot ? 'yes' : 'no'),
      champ('HELPER path-list', ''),
      champ('Auto upgrade', 'yes'),
      champ('Auto upgrade path', ''),
      'NVRAM/Config file',
      `      buffer size:   ${this.nvramBytes + NVRAM_RESERVE_BYTES}`,
      'Timeout for Config',
      '          Download:    0 seconds',
      'Config Download',
      '       via DHCP:       disabled (next boot: disabled)',
    ].join('\n');
  }

  /**
   * `boot enable-break` / `boot manual` — les deux seuls reglages
   * d'amorcage qu'un Catalyst expose vraiment, et que `show boot` lit.
   */
  setEnableBreak(on: boolean): void { this.enableBreak = on; }
  setManualBoot(on: boolean): void { this.manualBoot = on; }
  getManualBoot(): boolean { return this.manualBoot; }
  private enableBreak = false;
  private manualBoot = false;
}

/** `flash:c2960.bin` → `c2960.bin` ; `flash:/x` → `x`. */
function stripFs(name: string): string {
  return name.replace(/^[a-z]+:\/?/i, '');
}

/**
 * Le sous-répertoire demandé par `dir`, terminé par `/`, ou la chaîne
 * vide pour la racine. `flash:` et `flash:/` désignent la racine ;
 * `flash:archive/` et `flash:/archive` désignent le même répertoire, un
 * opérateur écrivant l'un ou l'autre indifféremment.
 */
function sousRepertoire(argument: string): string {
  const reste = stripFs(argument).replace(/^\/+/, '');
  if (reste === '') return '';
  return reste.endsWith('/') ? reste : reste + '/';
}
