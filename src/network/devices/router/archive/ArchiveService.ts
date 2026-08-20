export interface ArchivePath {
  path: string;
  timePeriodMin?: number;
  maximumVersions?: number;
  writeMemory?: boolean;
}

export interface ArchiveConfigLogger {
  enabled: boolean;
  logging: boolean;
  hidekeys: boolean;
  notifySyslogContent?: 'plaintext' | 'xml';
  /**
   * `logging size <n>` — le journal est CIRCULAIRE sur une vraie
   * machine, donc la taille n'est pas un ornement : c'est ce qui décide
   * quelle commande est encore consultable et laquelle a été poussée
   * dehors. Elle vivait dans un champ greffé par transtypage, donc dans
   * un type qui ne la déclarait pas.
   */
  bufferSize?: number;
}

/**
 * Une commande de configuration retenue par `log config`
 * (`docs/PRD-Pistes-Audit-Cisco.md` §3).
 *
 * C'est la seule trace de « qui a tapé quoi » qui n'exige AUCUN serveur :
 * elle vit sur la machine. `user` et `line` sont retenus séparément
 * parce que `show archive log config` les rend accolés (`admin@vty0`)
 * alors que le message syslog ne nomme que l'utilisateur.
 */
export interface ConfigLogRecord {
  readonly index: number;
  readonly session: number;
  readonly user: string;
  readonly line: string;
  readonly command: string;
  readonly whenMs: number;
}

export interface ArchivedRevision {
  index: number;
  capturedAtMs: number;
  source: 'manual' | 'auto-time' | 'auto-write-memory';
  bytes: number;
  path: string;
}

/**
 * Le support sur lequel une archive est réellement écrite.
 *
 * Port étroit vers `CiscoFileSystem` : ce service n'a pas besoin de
 * connaître le `flash:` d'IOS, seulement de pouvoir y déposer un
 * fichier, l'effacer et savoir s'il reste de la place. Sans ce port,
 * `archive config` ne produisait qu'une ligne de tableau — un archivage
 * qui n'écrit rien n'archive rien, et le fichier annoncé par
 * `show archive` restait introuvable par `dir flash:`.
 */
export interface ArchiveStorage {
  write(name: string, content: string): void;
  remove(name: string): boolean;
  freeBytes(): number;
  /**
   * Relire ce qui a été écrit. Le port ne savait qu'ÉCRIRE, si bien que
   * le contenu archivé n'était consultable par aucune vue — un diff
   * entre deux archives était donc impossible à calculer, quoi qu'en dise
   * le nom de la commande qui prétendait le rendre.
   */
  read?(name: string): string | null;
}

export class ArchiveService {
  private archivePath: ArchivePath = { path: '' };
  private configLogger: ArchiveConfigLogger = { enabled: false, logging: false, hidekeys: false };
  private readonly revisions: ArchivedRevision[] = [];
  private revisionCounter = 0;
  private storage: ArchiveStorage | null = null;
  private hostnameSource: (() => string) | null = null;

  /** Branche le `flash:` de l'équipement ; sans lui, rien n'est écrit. */
  attachStorage(s: ArchiveStorage): void { this.storage = s; }

  /**
   * Le nom de la machine, pour `$h`. Sans lui le chemin garderait la
   * variable telle quelle — c'est ce qui se passait : `path
   * flash:archive/$h-config` écrivait un fichier littéralement nommé
   * `$h-config-1`, sur toutes les machines, donc deux équipements
   * archivant vers le même serveur se seraient écrasés.
   */
  attachHostname(f: () => string): void { this.hostnameSource = f; }

  /**
   * `$h` → nom de la machine, `$t` → horodatage. Ce sont les deux
   * variables qu'IOS reconnaît dans `archive path`, et elles existent
   * précisément pour qu'un chemin serve plusieurs équipements et
   * plusieurs instants.
   *
   * Le format de `$t` est celui d'IOS : `Mon-D-YYYY-HH-MM-SS` — les
   * deux-points d'une heure ne peuvent pas figurer dans un nom de
   * fichier IOS, `:` séparant le système de fichiers du chemin.
   */
  private developper(chemin: string, quand: Date): string {
    return chemin
      .replace(/\$h/g, this.hostnameSource?.() ?? 'Router')
      .replace(/\$t/g, ArchiveService.horodatage(quand));
  }

  private static horodatage(d: Date): string {
    const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const deux = (n: number) => String(n).padStart(2, '0');
    return `${MOIS[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
      + `-${deux(d.getHours())}-${deux(d.getMinutes())}-${deux(d.getSeconds())}`;
  }
  hasStorage(): boolean { return this.storage !== null; }

  setPath(path: string): void { this.archivePath.path = path; }
  setTimePeriod(min: number): void { this.archivePath.timePeriodMin = min; }
  setMaximum(n: number): void { this.archivePath.maximumVersions = n; }
  setWriteMemory(on: boolean): void { this.archivePath.writeMemory = on; }
  getPath(): Readonly<ArchivePath> { return this.archivePath; }

  enableLogging(): void { this.configLogger.enabled = true; this.configLogger.logging = true; }
  disableLogging(): void { this.configLogger.logging = false; }
  setHidekeys(on: boolean): void { this.configLogger.hidekeys = on; }
  setNotifySyslog(content: 'plaintext' | 'xml'): void {
    this.configLogger.notifySyslogContent = content;
  }
  setLogBufferSize(n: number): void {
    this.configLogger.bufferSize = n;
    this.rognerJournal();
  }
  getConfigLogger(): Readonly<ArchiveConfigLogger> { return this.configLogger; }

  // ─── Journal des commandes de configuration (`log config`) ─────────

  private readonly configLog: ConfigLogRecord[] = [];
  private configLogCounter = 0;
  private sessionCounter = 0;
  private sessionCourante = 0;

  /**
   * Ouvre une session de journalisation. IOS numérote les sessions pour
   * que `show archive log config` puisse regrouper ce qu'un opérateur a
   * fait d'une traite — deux passages en configuration par la même
   * personne sont deux sessions, et les confondre ferait lire une suite
   * de commandes qui n'a jamais été tapée d'un seul tenant.
   */
  ouvrirSessionJournal(): number {
    this.sessionCounter += 1;
    this.sessionCourante = this.sessionCounter;
    return this.sessionCourante;
  }

  /**
   * Retient une commande. Rend l'enregistrement retenu, ou `null` quand
   * la journalisation est arrêtée — l'appelant s'en sert pour savoir
   * s'il doit émettre le message syslog qui va avec.
   */
  logCommand(user: string, line: string, command: string, whenMs: number): ConfigLogRecord | null {
    if (!this.configLogger.enabled || !this.configLogger.logging) return null;
    const texte = command.trim();
    if (texte.length === 0) return null;
    if (this.sessionCourante === 0) this.ouvrirSessionJournal();
    this.configLogCounter += 1;
    const record: ConfigLogRecord = {
      index: this.configLogCounter,
      session: this.sessionCourante,
      user: user || 'console',
      line: line || 'console',
      command: this.configLogger.hidekeys ? masquerSecrets(texte) : texte,
      whenMs,
    };
    this.configLog.push(record);
    this.rognerJournal();
    return record;
  }

  listConfigLog(): readonly ConfigLogRecord[] { return this.configLog; }
  clearConfigLog(): void { this.configLog.length = 0; }

  /**
   * Le journal est circulaire : la plus ancienne sort quand la taille
   * est dépassée. Sans cette borne, `logging size` serait un réglage que
   * rien ne lit, et le journal grossirait sans fin.
   */
  private rognerJournal(): void {
    const max = this.configLogger.bufferSize;
    if (max === undefined || max <= 0) return;
    while (this.configLog.length > max) this.configLog.shift();
  }

  /**
   * Écrit une archive et rend la révision — ou une erreur d'IOS quand le
   * support ne peut pas la recevoir.
   *
   * Ce qui rend l'archivage RÉEL plutôt que comptable :
   *
   *  - le contenu est déposé dans le `flash:` de l'équipement, donc
   *    `dir flash:` le voit et `more flash:cfg-1` le relit ;
   *  - la place est celle du châssis. Une flash pleine fait échouer
   *    l'archivage, comme sur un vrai routeur, au lieu d'ajouter une
   *    ligne à un tableau ;
   *  - `maximum` EFFACE le fichier le plus ancien au lieu d'oublier son
   *    enregistrement. Sans cela, la flash se remplirait de fichiers que
   *    plus rien ne nomme — une fuite, pas une rotation.
   */
  capture(
    source: ArchivedRevision['source'], contenu: string,
  ): ArchivedRevision | { erreur: string } {
    const quand = new Date();
    const chemin = this.developper(this.nextRevisionPath(), quand);
    const octets = contenu.length;
    if (this.storage && this.storage.freeBytes() < octets) {
      return { erreur: `%Error opening ${chemin} (No space left on device)` };
    }
    this.storage?.write(chemin, contenu);
    const rev: ArchivedRevision = {
      index: ++this.revisionCounter,
      capturedAtMs: quand.getTime(),
      source, bytes: octets, path: chemin,
    };
    this.revisions.push(rev);
    while (this.archivePath.maximumVersions !== undefined
      && this.revisions.length > this.archivePath.maximumVersions) {
      const jetee = this.revisions.shift();
      if (jetee) this.storage?.remove(jetee.path);
    }
    return rev;
  }
  listRevisions(): readonly ArchivedRevision[] { return [...this.revisions]; }

  asRunningConfigLines(): string[] {
    if (!this.archivePath.path && !this.configLogger.enabled) return [];
    const lines = ['archive'];
    if (this.archivePath.path) lines.push(` path ${this.archivePath.path}`);
    if (this.archivePath.timePeriodMin !== undefined) lines.push(` time-period ${this.archivePath.timePeriodMin}`);
    if (this.archivePath.maximumVersions !== undefined) lines.push(` maximum ${this.archivePath.maximumVersions}`);
    if (this.archivePath.writeMemory) lines.push(' write-memory');
    if (this.configLogger.enabled) {
      lines.push(' log config');
      if (this.configLogger.logging) lines.push('  logging enable');
      // `logging size` etait range et rendu NULLE PART : la taille du
      // journal circulaire disparaissait donc a l'enregistrement, et la
      // topologie rechargee retenait un nombre de commandes different de
      // celui que l'operateur avait choisi.
      if (this.configLogger.bufferSize !== undefined) {
        lines.push(`  logging size ${this.configLogger.bufferSize}`);
      }
      if (this.configLogger.hidekeys) lines.push('  hidekeys');
      if (this.configLogger.notifySyslogContent) lines.push(`  notify syslog contenttype ${this.configLogger.notifySyslogContent}`);
    }
    return lines;
  }

  /** Un archivage a-t-il été configuré ? (chemin, ou journal de config) */
  isConfigured(): boolean {
    return Boolean(this.archivePath.path) || this.configLogger.enabled;
  }

  /**
   * `show archive` — TROIS états, pas deux.
   *
   * Cette vue rendait « No archives configured / no revisions
   * captured. » dès que la liste des révisions était vide, sans jamais
   * regarder si un archivage avait été configuré. Elle contredisait donc
   * la running-config de la même machine, qui affichait au même instant
   * le bloc `archive` avec son chemin et son `maximum` — deux vues du
   * même équipement qui ne peuvent pas avoir raison ensemble.
   *
   * Le second défaut était dans la branche opposée : « No backups exist
   * on archive path » était empilé sans condition, y compris juste avant
   * d'énumérer les sauvegardes. La sortie s'annonçait vide puis se
   * remplissait.
   */
  formatShowArchive(): string {
    if (!this.isConfigured() && this.revisions.length === 0) {
      return 'No archives configured / no revisions captured.';
    }
    const lines = [`The maximum archive configurations allowed is ${this.archivePath.maximumVersions ?? 14}.`];
    lines.push(`There are currently ${this.revisions.length} archive `
      + `configuration${this.revisions.length === 1 ? '' : 's'} saved.`);
    if (this.revisions.length === 0) {
      lines.push('No backups exist on archive path');
    }
    lines.push(` The next archive file will be named `
      + `${this.developper(this.nextRevisionPath(), new Date())}`);
    lines.push(' Archive #  Name');
    const dernier = this.revisions.length;
    this.revisions.forEach((r, i) => {
      const marque = i === dernier - 1 ? ' <- Most Recent' : '';
      lines.push(`   ${String(r.index).padEnd(9)}${r.path}${marque}`);
    });
    return lines.join('\n');
  }

  /**
   * Le nom du prochain fichier d'archive — `<chemin>-<n>`, la convention
   * d'IOS, qui suffixe le chemin configuré par un numéro de révision
   * croissant. C'est ce que `archive config` écrit et ce que
   * `show archive` énumère ensuite.
   */
  nextRevisionPath(): string {
    return `${this.archivePath.path}-${this.revisionCounter + 1}`;
  }

  /**
   * `show archive config differences [<avant> [<apres>]]` — la commande
   * la plus utile de tout ce sous-système pour un auditeur : elle dit ce
   * qui a CHANGÉ entre deux instants, ce qu'aucune autre vue ne dit.
   *
   * Elle rendait une PHRASE (« Differences between latest two archives
   * (3 → 4) ») et non un diff : le nom annonçait une comparaison, le
   * corps n'en faisait aucune, et rien ne lisait le contenu pourtant
   * réellement écrit sur `flash:`. Sans argument, IOS compare la
   * dernière archive à la configuration courante — c'est la question
   * qu'on pose le plus souvent, « qu'est-ce qui a bougé depuis la
   * dernière sauvegarde ? ».
   */
  formatShowArchiveDiff(avant?: string, apres?: string): string {
    if (avant === undefined || apres === undefined) return 'No archive differences available.';
    return diffContextuel(avant, apres);
  }

  /** Le contenu écrit pour une révision, relu depuis le support. */
  revisionAt(index: number): ArchivedRevision | undefined {
    return this.revisions.find((r) => r.index === index);
  }

  /**
   * Relit une archive PAR SON CHEMIN, tel que `show archive` le nomme.
   *
   * Ce que ce service écrivait sur `flash:` n'était jamais relu par
   * personne : le fichier existait, `dir flash:` le montrait, et aucune
   * vue n'en lisait le contenu. Un diff en a besoin, et c'est ce qui le
   * rend réel plutôt que comptable.
   */
  readArchivedConfig(reference: string): string | null {
    if (!this.storage?.read) return null;
    const direct = this.storage.read(reference);
    if (direct !== null && direct !== undefined) return direct;
    // `show archive` numérote les révisions ; un opérateur qui tape le
    // numéro plutôt que le chemin veut la même chose.
    if (/^\d+$/.test(reference)) {
      const rev = this.revisionAt(Number(reference));
      if (rev) return this.storage.read(rev.path) ?? null;
    }
    return null;
  }

  /** La dernière archive écrite, celle à laquelle on compare par défaut. */
  latestArchivedConfig(): string | null {
    const derniere = this.revisions[this.revisions.length - 1];
    if (!derniere) return null;
    return this.storage?.read?.(derniere.path) ?? null;
  }
}

/**
 * Le diff contextuel d'IOS. Une ligne retirée est préfixée `-`, une
 * ligne ajoutée `+`, et la ligne de contexte qui les porte est répétée
 * — c'est ce qui distingue « `shutdown` a disparu » de « `shutdown` a
 * disparu SUR Fa0/2 », la seule des deux qui soit une information.
 */
export function diffContextuel(avant: string, apres: string): string {
  const a = corpsDeConfiguration(avant);
  const b = corpsDeConfiguration(apres);
  const ensembleA = new Set(a);
  const ensembleB = new Set(b);

  const retirees = a.filter((l) => l.trim() && !ensembleB.has(l));
  const ajoutees = b.filter((l) => l.trim() && !ensembleA.has(l));
  if (retirees.length === 0 && ajoutees.length === 0) return '!No changes were found';

  const lignes = ['!Contextual Config Diffs:'];
  for (const l of retirees) lignes.push(...avecContexte(a, l, '-'));
  for (const l of ajoutees) lignes.push(...avecContexte(b, l, '+'));
  return lignes.join('\n');
}

/**
 * Le CORPS d'une configuration : ce que l'opérateur a écrit, sans le
 * préambule que la vue ajoute.
 *
 * `Current configuration : 729 bytes` change dès qu'une seule lettre
 * change ailleurs, et `Building configuration...` n'appartient pas à la
 * configuration du tout. Les garder ferait de chaque diff un diff qui
 * signale toujours au moins deux différences, dont aucune n'est une
 * modification — l'auditeur apprendrait à ne plus les lire.
 */
function corpsDeConfiguration(texte: string): string[] {
  return texte.split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !/^Building configuration/i.test(l)
      && !/^Current configuration\s*:/i.test(l)
      && !/^!\s*Last configuration change/i.test(l)
      && !/^!\s*NVRAM config last updated/i.test(l));
}

/**
 * Une ligne indentée appartient au bloc qui la précède (IOS marque ses
 * sous-modes par l'indentation). On remonte donc au premier parent non
 * indenté pour le rendre au-dessus, sans le préfixer — c'est du
 * contexte, pas un changement.
 */
function avecContexte(source: string[], ligne: string, signe: '+' | '-'): string[] {
  const i = source.indexOf(ligne);
  const indente = /^\s/.test(ligne);
  if (!indente || i <= 0) return [`${signe}${ligne}`];
  for (let j = i - 1; j >= 0; j--) {
    if (!/^\s/.test(source[j]) && source[j].trim() && source[j].trim() !== '!') {
      return [source[j], `${signe}${ligne}`];
    }
  }
  return [`${signe}${ligne}`];
}

/**
 * `hidekeys` — masque les secrets AVANT qu'ils entrent dans le journal.
 *
 * Le masquage doit avoir lieu à l'ÉCRITURE et non à l'affichage : un
 * journal d'audit qui retiendrait le secret en clair pour le cacher
 * ensuite serait exactement la fuite que cette option existe pour
 * empêcher, et il suffirait d'une autre vue pour l'exposer.
 */
export function masquerSecrets(commande: string): string {
  return commande
    .replace(/\b(secret|password|key)\b(\s+\d)?\s+\S+/gi,
      (_m, mot: string, chiffre: string | undefined) => `${mot}${chiffre ?? ''} <removed>`)
    .replace(/\b(auth|priv)\s+(sha|md5|aes|des|3des)(\s+\d+)?\s+\S+/gi,
      (_m, mot: string, algo: string, bits: string | undefined) =>
        `${mot} ${algo}${bits ?? ''} <removed>`);
}
