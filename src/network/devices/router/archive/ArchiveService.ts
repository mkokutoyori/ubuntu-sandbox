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
}

export class ArchiveService {
  private archivePath: ArchivePath = { path: '' };
  private configLogger: ArchiveConfigLogger = { enabled: false, logging: false, hidekeys: false };
  private readonly revisions: ArchivedRevision[] = [];
  private revisionCounter = 0;
  private storage: ArchiveStorage | null = null;

  /** Branche le `flash:` de l'équipement ; sans lui, rien n'est écrit. */
  attachStorage(s: ArchiveStorage): void { this.storage = s; }
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
  setLogBufferSize(n: number): void { (this.configLogger as unknown as { bufferSize?: number }).bufferSize = n; }
  getConfigLogger(): Readonly<ArchiveConfigLogger> { return this.configLogger; }

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
    const chemin = this.nextRevisionPath();
    const octets = contenu.length;
    if (this.storage && this.storage.freeBytes() < octets) {
      return { erreur: `%Error opening ${chemin} (No space left on device)` };
    }
    this.storage?.write(chemin, contenu);
    const rev: ArchivedRevision = {
      index: ++this.revisionCounter,
      capturedAtMs: Date.now(),
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
    if (this.revisions.length === 0) {
      lines.push('No backups exist on archive path');
    }
    if (this.archivePath.path) lines.push(`Archive path: ${this.archivePath.path}`);
    for (const r of this.revisions) {
      lines.push(`  ${r.index}: ${r.path} (${new Date(r.capturedAtMs).toISOString()}, ${r.bytes}B, src=${r.source})`);
    }
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

  formatShowArchiveDiff(): string {
    if (this.revisions.length < 2) return 'No archive differences available.';
    return `Differences between latest two archives (${this.revisions[this.revisions.length - 2].index} → ${this.revisions[this.revisions.length - 1].index})`;
  }
}
