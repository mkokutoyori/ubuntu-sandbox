/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — chronyd, et le temps d'une machine
 * Linux.
 *
 * ── Le defaut mesure ────────────────────────────────────────────────
 *
 * Le paquet `chrony` etait declare installe et **rien n'existait** : ni
 * binaire, ni unite, ni fichier de configuration. Pire, sur cette meme
 * machine sans aucun demon de temps :
 *
 * ```
 * $ timedatectl
 * System clock synchronized: yes
 *               NTP service: active
 * ```
 *
 * Deux affirmations que rien ne soutenait — la forme de defaut que ce
 * depot ferme partout ailleurs. Et `timedatectl set-timezone
 * Africa/Douala` etait accepte sans rien changer.
 *
 * ── Ce que ce service decide ────────────────────────────────────────
 *
 * Il n'y a pas de second moteur NTP : chronyd pilote le `NtpAgent`, le
 * meme que Cisco et Huawei. Un simulateur avec deux moteurs finirait par
 * donner deux reponses a la meme question, facture que ce depot a deja
 * payee ailleurs (deux registres Windows, deux piles SSH).
 *
 * Ce que le service apporte est ce que chronyd apporte vraiment : la
 * LECTURE de `/etc/chrony/chrony.conf` — donc quelles sources
 * interroger, lesquelles preferer — et la reponse aux questions de
 * `chronyc`.
 *
 * ── Trois choix, et leur raison ─────────────────────────────────────
 *
 * 1. **L'unite s'appelle `chrony` sur Debian** (`chronyd` sur RHEL, et
 *    le tutoriel montre les deux). Cette image est une Debian ; les deux
 *    noms sont acceptes par le gestionnaire de services, parce qu'un
 *    lecteur qui suit la colonne RHEL du tutoriel ne doit pas tomber sur
 *    un `Unit could not be found` qui ne lui apprendrait rien.
 * 2. **Un fichier de configuration MANQUANT empeche le demarrage**
 *    (`Cannot open configuration file`), un fichier VIDE ne l'empeche
 *    pas : c'est la distinction que `CriticalFiles.ts` tient deja pour
 *    sshd, et elle est vraie de chronyd aussi.
 * 3. **`iburst` est la seule directive dont l'effet est visible ici** :
 *    elle demande une rafale au demarrage, donc une convergence
 *    immediate. Sans elle, la premiere mesure attend le premier
 *    intervalle de scrutation. C'est exactement ce que le tutoriel
 *    annonce (« envoyer 8 paquets au demarrage pour converger
 *    rapidement »), et c'est observable.
 */

import { simulationNowMs } from '@/network/core/SystemClock';

import type { LocalReference, NtpAgent, NtpPlatformProfile } from '../../../ntp/NtpAgent';
import { DEFAULT_SELECTION_PARAMETERS } from '../../../ntp/ChronySelection';
import { TimeSmoothing } from '../../../ntp/TimeSmoothing';
import type { UdpListener } from '../../EndHost';
import type { UdpSendRequest } from '../../../layers/transport/UdpEgress';
import { IPAddress as WireAddress } from '../../../core/types';
import { ChronyCommandServer } from './ChronyCommandServer';
import { ChronyNts, type ChronyNtsHost } from './ChronyNts';
import { ChronyDaemonView } from './ChronyDaemonView';
import { UDP_PORT_NTP, type NtpVersion } from '../../../ntp/types';
import { parseChronyConf, parseChronySource, type ChronyConf, type ChronySource, CHRONY_CONF_DEBIAN } from './ChronyConfig';
import { ChronyAccessTable, parseChronySubnet } from './ChronyAccess';
import { IPAddress } from '../../../core/types';
import { parseChronyKeys, type ChronyKeysLecture } from './ChronyKeys';
import { isValidIPv4 } from '../../../core/ip';
import type { ServiceSocketServer } from '../ports/ServiceSocketServer';
import type { PortSpec } from '../../../core/ports/PortNumber';

/** Le chemin Debian, celui que le tutoriel fait editer. */
export const CHRONY_CONF_PATH = '/etc/chrony/chrony.conf';
/** Le chemin RHEL, que le tutoriel cite aussi. */
export const CHRONY_CONF_PATH_RHEL = '/etc/chrony.conf';

export interface ChronyHost extends ChronyNtsHost {
  /** Lire un fichier du VFS ; `null` quand il n'existe pas. */
  readFile(chemin: string): string | null;
  /** L'agent NTP de la machine — le seul moteur. */
  ntp(): NtpAgent;
  bindNtpPort?(port: number): boolean;
  releaseNtpPort?(port: number): void;
  daemonExited?(reason: string): void;
  bindCommandAddress?(address: string, port: number, listener: UdpListener): boolean;
  releaseCommandAddress?(address: string, port: number): void;
  sendUdpDatagram?(request: UdpSendRequest): boolean;
}

const CHRONY_PROFILE: Partial<NtpPlatformProfile> = {
  respondsWhenUnsynchronized: true,
  unsynchronizedRootBoundMs: 1000,
  silentOnBadAuthentication: true,
  acceptsExtensionFields: false,
  statelessSymmetricReply: true,
  localReferenceIsAddress: true,
  pollModel: 'chrony',
};

export class LinuxChronyService implements ServiceSocketServer {
  private actif = false;
  private conf: ChronyConf = parseChronyConf('');
  private demarreALe = 0;
  /** Le nombre de sauts d'horloge deja consommes sur le quota `makestep`. */
  private sautsFaits = 0;

  private readonly nts: ChronyNts;

  constructor(private readonly host: ChronyHost) {
    this.nts = new ChronyNts(host, () => this.conf.ntpPort);
  }

  getNts(): ChronyNts { return this.nts; }

  dumpAuthData(): void { this.nts.dump((ip) => this.host.ntp().getAssociation(ip)?.port ?? UDP_PORT_NTP); }

  /** Ce que le fichier de cles a donne au dernier demarrage/relecture. */
  private cles: ChronyKeysLecture = { cles: [], refusees: [] };

  open(spec: PortSpec): boolean {
    return this.host.bindNtpPort?.(spec.port) ?? false;
  }

  close(spec: PortSpec): void {
    this.host.releaseNtpPort?.(spec.port);
  }

  isRunning(): boolean { return this.actif; }
  getConf(): ChronyConf { return this.conf; }
  getCles(): ChronyKeysLecture { return this.cles; }
  getUptimeSec(): number {
    return this.actif ? Math.max(0, Math.floor((simulationNowMs() - this.demarreALe) / 1000)) : 0;
  }

  /**
   * Le chemin reellement lu. chronyd ne cherche pas : c'est son unite
   * qui le lui passe (`-f`). Debian et RHEL n'ayant pas le meme, les
   * deux sont acceptes — le premier present gagne, et l'ordre est celui
   * de Debian puisque cette image en est une.
   */
  cheminConf(): string | null {
    for (const c of [CHRONY_CONF_PATH, CHRONY_CONF_PATH_RHEL]) {
      if (this.host.readFile(c) !== null) return c;
    }
    return null;
  }

  /**
   * Ce que `systemctl start chrony` execute.
   *
   * Un fichier absent est un echec de demarrage nomme, comme sur une
   * vraie machine ; un fichier vide demarre sur les valeurs par defaut,
   * ce qui est legal et sans source — donc sans synchronisation.
   */
  start(): { ok: true } | { ok: false; erreur: string } {
    const chemin = this.cheminConf();
    if (chemin === null) {
      return {
        ok: false,
        erreur: `Cannot open configuration file ${CHRONY_CONF_PATH}: No such file or directory`,
      };
    }
    this.conf = parseChronyConf(this.host.readFile(chemin) ?? '');
    this.host.bindNtpPort?.(UDP_PORT_NTP);
    this.host.ntp().setProfile(CHRONY_PROFILE);
    this.host.ntp().setNtsSupport(this.nts);
    this.appliquer();
    this.actif = true;
    this.demarreALe = simulationNowMs();
    this.sautsFaits = 0;
    this.localOverride = null;
    this.commandPackets = 0;
    this.manualSamples = [];
    this.host.ntp().start();
    return { ok: true };
  }

  private openCommandChannel(): void {
    const port = this.conf.commandPort;
    const addresses = port === 0 ? [] : this.conf.bindCommandAddresses.length > 0 ? [...this.conf.bindCommandAddresses] : ['127.0.0.1'];
    const key = `${port}:${addresses.join(',')}`;
    if (key === this.commandKey && this.commandServer !== null) {
      const limit = this.conf.commandRateLimit;
      this.commandServer.setRateLimit(limit === null ? null
        : { intervalExponent: limit.interval, burst: limit.burst, leakExponent: limit.leak, kod: false });
      return;
    }
    this.closeCommandChannel();
    this.commandKey = key;
    if (addresses.length === 0) return;
    const server = new ChronyCommandServer(
      this,
      () => (this.actif ? new ChronyDaemonView(this, this.host.ntp()) : null),
      {
        send: (destination, destinationPort, sourcePort, source, payload) => this.host.sendUdpDatagram?.({
          destination, destinationPort, sourcePort, payload, payloadBytes: payload.length,
          ...(source === undefined ? {} : { source }),
        }) ?? false,
      },
    );
    const limit = this.conf.commandRateLimit;
    server.setRateLimit(limit === null ? null
      : { intervalExponent: limit.interval, burst: limit.burst, leakExponent: limit.leak, kod: false });
    this.commandServer = server;
    for (const address of addresses) {
      const bound = this.host.bindCommandAddress?.(address, port, ({ sourceIP, destinationIP, udp }) => {
        if (!(sourceIP instanceof WireAddress) || !(destinationIP instanceof WireAddress) || !(udp.payload instanceof Uint8Array)) return;
        server.handle(sourceIP, udp.sourcePort, destinationIP, udp.destinationPort, udp.payload);
      });
      if (bound) this.commandBindings.push({ address, port });
    }
  }

  private closeCommandChannel(): void {
    for (const binding of this.commandBindings) this.host.releaseCommandAddress?.(binding.address, binding.port);
    this.commandBindings = [];
    this.commandServer = null;
    this.commandKey = '';
  }

  stop(): void {
    if (!this.actif) return;
    this.closeCommandChannel();
    this.nts.shutdown((ip) => this.host.ntp().getAssociation(ip)?.port ?? UDP_PORT_NTP);
    this.host.ntp().setNtsSupport(null);
    this.actif = false;
    this.host.releaseNtpPort?.(UDP_PORT_NTP);
    if (this.conf.ntpPort !== UDP_PORT_NTP && this.conf.ntpPort > 0) this.host.releaseNtpPort?.(this.conf.ntpPort);
    const agent = this.host.ntp();
    agent.stop();
    // Un demon arrete ne laisse pas ses associations derriere lui : c'est
    // ce qui fait que `chronyc tracking` ne repond plus, et c'est le
    // sens de `systemctl stop chrony` dans un lab.
    for (const ip of [...agent.getConfig().associations.keys()]) agent.removeServer(ip);
    agent.setLocalStratum(16);
    agent.setServerMode(false);
  }

  /** `systemctl reload` / `chronyc reload sources` : relire le fichier. */
  reload(): { ok: true } | { ok: false; erreur: string } {
    if (!this.actif) return { ok: true };
    const chemin = this.cheminConf();
    if (chemin === null) {
      return { ok: false, erreur: `Cannot open configuration file ${CHRONY_CONF_PATH}` };
    }
    this.conf = parseChronyConf(this.host.readFile(chemin) ?? '');
    this.appliquer();
    return { ok: true };
  }

  /**
   * `chronyc makestep` : corriger l'horloge d'un coup au lieu de la
   * faire glisser. Le quota de `makestep <seuil> <limite>` est REEL —
   * un lab qui en demande un quatrieme apres `makestep 1 3` doit se le
   * voir refuser, sinon la directive ne veut rien dire.
   */
  makestep(): { ok: true } | { ok: false; erreur: string } {
    if (!this.actif) return { ok: false, erreur: '506 Cannot talk to daemon' };
    if (!this.host.ntp().forcerSaut()) return { ok: false, erreur: '500 Failure' };
    this.sautsFaits++;
    return { ok: true };
  }

  private readonly ntpAccess = new ChronyAccessTable();
  private readonly cmdAccess = new ChronyAccessTable();
  private manualEnabled = false;
  private manualSamples: { atMs: number; slewed: number; original: number; residual: number }[] = [];
  private smoothKey = '';
  private commandServer: ChronyCommandServer | null = null;
  private commandBindings: { address: string; port: number }[] = [];
  private commandKey = '';
  private localOverride: LocalReference | 'off' | null = null;
  private commandPackets = 0;

  getCommandPackets(): number { return this.commandPackets; }
  countCommandPacket(): void { this.commandPackets++; }
  isManualEnabled(): boolean { return this.manualEnabled; }
  getManualSamples(): readonly { atMs: number; slewed: number; original: number; residual: number }[] { return this.manualSamples; }

  isNtpClientAllowed(address: IPAddress): boolean { return this.ntpAccess.isAllowed(address); }
  isCommandClientAllowed(address: IPAddress): boolean { return this.cmdAccess.isAllowed(address); }

  private rebuildAccess(): void {
    this.ntpAccess.clear();
    this.cmdAccess.clear();
    for (const directive of this.conf.access) this.applyAccess(directive.kind, directive.subnet, directive.includingChildren);
  }

  applyAccess(kind: 'allow' | 'deny' | 'cmdallow' | 'cmddeny', subnet: { network: number; prefix: number }, includingChildren: boolean): void {
    const table = kind === 'allow' || kind === 'deny' ? this.ntpAccess : this.cmdAccess;
    table.apply(kind === 'allow' || kind === 'cmdallow', subnet, includingChildren);
  }

  setMakestep(thresholdSeconds: number, limit: number): void {
    this.host.ntp().setReglagesDiscipline({
      seuilSautMs: thresholdSeconds * 1000, limiteSauts: limit, reinitialiserAssociationsAuSaut: false,
    });
  }

  removeSource(ip: string): boolean {
    const agent = this.host.ntp();
    if (agent.getAssociation(ip) === undefined) return false;
    this.nts.untrack(ip);
    agent.removeServer(ip);
    return true;
  }

  setManual(enabled: boolean): void { this.manualEnabled = enabled; }
  resetManual(): void { this.manualSamples = []; }
  deleteManualSample(index: number): boolean {
    if (index < 0 || index >= this.manualSamples.length) return false;
    this.manualSamples.splice(index, 1);
    return true;
  }

  settime(targetMs: number): { ok: true; deltaMs: number } | { ok: false; status: string } {
    if (!this.manualEnabled) return { ok: false, status: '505 Facility not enabled in daemon' };
    const agent = this.host.ntp();
    const deltaMs = targetMs - agent.now();
    const last = this.manualSamples[this.manualSamples.length - 1];
    if (last !== undefined && simulationNowMs() - last.atMs < 1000) return { ok: false, status: '500 Failure' };
    agent.stepClockBy(deltaMs);
    this.manualSamples.push({ atMs: agent.now(), slewed: 0, original: -deltaMs / 1000, residual: 0 });
    return { ok: true, deltaMs };
  }

  setLocal(reference: LocalReference | 'off'): void {
    this.localOverride = reference;
    this.applyLocal();
  }

  private applyLocal(): void {
    const agent = this.host.ntp();
    const declared: LocalReference | null = this.conf.localStratum === null ? null
      : { stratum: this.conf.localStratum, distance: this.conf.localDistance, orphan: this.conf.localOrphan };
    const reference = this.localOverride ?? declared;
    if (reference === null || reference === 'off') {
      agent.setLocalReference(null);
      if (this.localOverride === 'off') agent.setServerMode(false);
      return;
    }
    agent.setServerMode(true);
    agent.setLocalStratum(reference.stratum);
    agent.setLocalReference(reference);
  }

  addSource(kind: 'server' | 'peer' | 'pool', host: string, words: readonly string[]): { ok: true } | { ok: false; status: string } {
    const source = parseChronySource(kind, [host, ...words]);
    if (source === null) return { ok: false, status: 'Invalid syntax for add command' };
    if (!isValidIPv4(host)) return { ok: false, status: 'Invalid host/IP address' };
    if (this.host.ntp().getAssociation(host) !== undefined) return { ok: false, status: 'already' };
    this.installSource(source);
    return { ok: true };
  }

  private declaredSources(): ChronySource[] {
    const sources = [...this.conf.sources];
    for (const directory of this.conf.sourceDirs) {
      const names = (this.host.listDirectory?.(directory) ?? []).filter((name) => name.endsWith('.sources')).sort();
      for (const name of names) {
        const text = this.host.readFile(`${directory.replace(/\/$/, '')}/${name}`) ?? '';
        for (const line of text.split('\n')) {
          const words = line.replace(/[#!].*$/, '').trim().split(/\s+/);
          const kind = words[0]?.toLowerCase();
          if (kind !== 'server' && kind !== 'pool' && kind !== 'peer') continue;
          const source = parseChronySource(kind, words.slice(1));
          if (source !== null && !sources.some((s) => s.hote === source.hote)) sources.push(source);
        }
      }
    }
    return sources;
  }

  private installSource(source: ChronySource): void {
    const agent = this.host.ntp();
    const existed = agent.getAssociation(source.hote) !== undefined;
    const restored = this.nts.track(source, simulationNowMs());
    const options = {
      iburst: source.iburst, burst: source.burst, minpoll: source.minpoll, maxpoll: source.maxpoll,
      online: existed ? !source.offline : false, version: source.version as NtpVersion | undefined,
    };
    if (source.genre === 'peer') agent.addPeer(source.hote, source.prefer, source.keyId, options);
    else agent.addServer(source.hote, source.prefer, source.keyId, 'ntp', options);
    agent.setSourceCriteria(source.hote, {
      noselect: source.noselect, trust: source.trust, require: source.require,
      maxDelayMs: source.maxdelay === undefined ? undefined : source.maxdelay * 1000,
      maxDelayRatio: source.maxdelayratio, maxDelayDevRatio: source.maxdelaydevratio,
      minStratum: source.minstratum, pollTarget: source.polltarget, port: source.port ?? restored?.ntpPort,
      presend: source.presend, autoOffline: source.autoOffline, copy: source.copy,
      maxDelayQuant: source.maxdelayquant, filterLength: source.filter, fixedOffsetMs: source.offsetCorrection === undefined ? undefined : source.offsetCorrection * 1000,
      statistics: { minSamples: source.minsamples, maxSamples: source.maxsamples, minDelay: source.mindelay, asymmetry: source.asymmetry },
    });
    if (!existed && !source.offline) agent.setSourceOnline(source.hote, true);
  }

  /**
   * Traduit le fichier en associations sur l'agent.
   *
   * Une source est ecartee lorsque son nom n'est pas une adresse : ce
   * simulateur n'a pas de resolveur cote demon, et un `pool
   * 2.debian.pool.ntp.org` ne peut donc PAS etre interroge. Il reste
   * declare dans la configuration — c'est ce que le fichier de Debian
   * contient a l'installation — et `chronyc sources` le montre absent
   * plutot que d'inventer une adresse.
   */
  /**
   * Charger le fichier de cles sur l'agent.
   *
   * Chez chrony, une cle presente dans le fichier EST une cle de
   * confiance : il n'y a pas de `trusted-key` a cote, comme sur IOS —
   * ecrire la cle dans un fichier que seul root peut lire est la
   * declaration de confiance. Les deux appels vont donc de pair.
   *
   * De meme, chrony n'a **aucun interrupteur global** equivalent a `ntp
   * authenticate` : c'est le `key N` de la ligne `server` qui dit tout.
   * `setAuthenticate(true)` reproduit exactement cela, puisque l'agent
   * n'exige une reponse authentifiee que d'une association qui NOMME une
   * cle — sans `key N`, le drapeau ne change rien.
   */
  reloadKeys(): void {
    this.chargerCles();
    this.nts.reloadKeys();
  }

  private chargerCles(): void {
    const agent = this.host.ntp();
    for (const id of [...agent.getConfig().authKeys.keys()]) {
      agent.removeAuthKey(id);
      agent.removeTrustedKey(id);
    }
    this.cles = { cles: [], refusees: [] };
    if (!this.conf.keyfile) { agent.setAuthenticate(false); return; }
    const texte = this.host.readFile(this.conf.keyfile);
    if (texte === null) { agent.setAuthenticate(false); return; }
    this.cles = parseChronyKeys(texte);
    for (const k of this.cles.cles) {
      agent.addAuthKey(k.id, k.algo, k.cle);
      agent.addTrustedKey(k.id);
    }
    agent.setAuthenticate(this.cles.cles.length > 0);
  }

  private appliquer(): void {
    const agent = this.host.ntp();
    // Les cles AVANT les sources : `addServer(..., keyId)` declenche une
    // interrogation immediate, qui signerait avec une cle pas encore
    // chargee — donc un premier paquet sans condensé, refuse par le
    // serveur pour une raison qui n'existe plus a la seconde suivante.
    this.chargerCles();
    this.nts.apply(this.conf.nts);
    const voulues = new Set<string>();
    for (const s of this.declaredSources()) {
      if (!isValidIPv4(s.hote)) continue;
      voulues.add(s.hote);
      this.installSource(s);
    }
    // Ce que le fichier ne declare plus doit disparaitre : sans cela un
    // `reload` ne serait qu'un ajout, et retirer une ligne du fichier
    // n'aurait aucun effet.
    for (const ip of [...agent.getConfig().associations.keys()]) {
      if (!voulues.has(ip)) { this.nts.untrack(ip); agent.removeServer(ip); }
    }
    // `makestep <seuil> <limite>` est un reglage de la DISCIPLINE, pas
    // une commande : il decide a quel ecart chronyd saute au lieu de
    // glisser, et combien de fois. Il etait lu et range sans jamais
    // atteindre le moteur (lot N9).
    agent.setReglagesDiscipline(this.conf.makestep
      ? { seuilSautMs: this.conf.makestep.seuilSec * 1000, limiteSauts: this.conf.makestep.limite, reinitialiserAssociationsAuSaut: false }
      : { reinitialiserAssociationsAuSaut: false });
    agent.setSelectionParameters({
      ...DEFAULT_SELECTION_PARAMETERS, ...this.conf.selection,
    });
    agent.getReference().setMaxUpdateSkewPpm(this.conf.maxUpdateSkewPpm ?? 1000);
    agent.getReference().setMaxChange(this.conf.maxChange);
    if (this.conf.ntpPort !== UDP_PORT_NTP && this.conf.ntpPort > 0) this.host.bindNtpPort?.(this.conf.ntpPort);
    agent.setServerPort(this.conf.ntpPort);
    const smooth = this.conf.smooth;
    const smoothKey = smooth === null ? '' : `${smooth.maxFrequencyPpm}:${smooth.maxWanderPpm}:${smooth.leapOnly}`;
    if (smoothKey !== this.smoothKey) {
      this.smoothKey = smoothKey;
      agent.setSmoothing(smooth === null ? null : new TimeSmoothing(smooth.maxFrequencyPpm, smooth.maxWanderPpm, smooth.leapOnly));
    }
    agent.setFatalHandler(() => {
      this.stop();
      this.host.daemonExited?.('exit-code');
    });
    this.applyLocal();
    this.manualEnabled = this.conf.manual;
    this.rebuildAccess();
    this.openCommandChannel();
    agent.setClientAdmission((ip) => {
      const address = IPAddress.tryParse(ip);
      return address !== null && this.ntpAccess.isAllowed(address);
    });
    const limit = this.conf.ratelimit;
    agent.setRateLimit(limit === null ? null : { intervalExponent: limit.interval, burst: limit.burst, leakExponent: limit.leak, kod: false });
    agent.setEnabled(true);
  }

  /** Le texte que le paquet Debian depose a l'installation. */
  static confParDefaut(): string { return CHRONY_CONF_DEBIAN; }
}
