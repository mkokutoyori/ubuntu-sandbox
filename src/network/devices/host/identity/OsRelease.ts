/**
 * OsRelease — domain model of the operating-system identity.
 *
 * Mirrors the `os-release(5)` record: distribution id, human names, version
 * and codename. It is the single source of truth behind `/etc/os-release`,
 * `/etc/lsb-release`, the `Operating System` line of `hostnamectl`, and the
 * `lsb_release` command.
 */

export interface OsReleaseInit {
  id?: string;
  idLike?: string;
  name?: string;
  prettyName?: string;
  version?: string;
  versionId?: string;
  versionCodename?: string;
  homeUrl?: string;
  supportUrl?: string;
  bugReportUrl?: string;
}

export class OsRelease {
  /** Lower-case distribution id (`ID`), e.g. `ubuntu`. */
  id: string;
  /** Parent distribution (`ID_LIKE`), e.g. `debian`. */
  idLike: string;
  /** Distributor name (`NAME`), e.g. `Ubuntu`. */
  name: string;
  /** Full human label (`PRETTY_NAME`), e.g. `Ubuntu 22.04.4 LTS`. */
  prettyName: string;
  /** Full version string (`VERSION`). */
  version: string;
  /** Numeric version (`VERSION_ID`), e.g. `22.04`. */
  versionId: string;
  /** Release codename (`VERSION_CODENAME`), e.g. `jammy`. */
  versionCodename: string;
  homeUrl: string;
  supportUrl: string;
  bugReportUrl: string;

  constructor(init: OsReleaseInit = {}) {
    this.id = init.id ?? 'ubuntu';
    this.idLike = init.idLike ?? 'debian';
    this.name = init.name ?? 'Ubuntu';
    this.prettyName = init.prettyName ?? 'Ubuntu 22.04.4 LTS';
    this.version = init.version ?? '22.04.4 LTS (Jammy Jellyfish)';
    this.versionId = init.versionId ?? '22.04';
    this.versionCodename = init.versionCodename ?? 'jammy';
    this.homeUrl = init.homeUrl ?? 'https://www.ubuntu.com/';
    this.supportUrl = init.supportUrl ?? 'https://help.ubuntu.com/';
    this.bugReportUrl = init.bugReportUrl ?? 'https://bugs.launchpad.net/ubuntu/';
  }

  static ubuntu(): OsRelease {
    return new OsRelease();
  }

  /** Render the canonical `/etc/os-release` content. */
  render(): string {
    return [
      `PRETTY_NAME="${this.prettyName}"`,
      `NAME="${this.name}"`,
      `VERSION_ID="${this.versionId}"`,
      `VERSION="${this.version}"`,
      `VERSION_CODENAME=${this.versionCodename}`,
      `ID=${this.id}`,
      `ID_LIKE=${this.idLike}`,
      `HOME_URL="${this.homeUrl}"`,
      `SUPPORT_URL="${this.supportUrl}"`,
      `BUG_REPORT_URL="${this.bugReportUrl}"`,
      `UBUNTU_CODENAME=${this.versionCodename}`,
      '',
    ].join('\n');
  }

  /** Render the legacy `/etc/lsb-release` content. */
  renderLsbRelease(): string {
    return [
      `DISTRIB_ID=${this.name}`,
      `DISTRIB_RELEASE=${this.versionId}`,
      `DISTRIB_CODENAME=${this.versionCodename}`,
      `DISTRIB_DESCRIPTION="${this.prettyName}"`,
      '',
    ].join('\n');
  }
}
