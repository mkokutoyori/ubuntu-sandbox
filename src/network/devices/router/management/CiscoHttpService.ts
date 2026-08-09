/**
 * Le serveur HTTP d'IOS (`docs/PRD-Serveur-HTTP-Cisco.md`).
 *
 * `ip http server` et `ip http secure-server` étaient deux booléens de
 * `CiscoConfigState`, une table dont le rendu (`runningConfigLines()`)
 * n'a AUCUN appelant de production : les deux commandes étaient donc
 * acceptées, retenues, et absentes de la configuration dans les deux
 * sens — ce qui dépasse l'affichage, la configuration rendue étant
 * rejouée à l'import d'une topologie. Aucun port n'était ouvert, et la
 * famille qui accompagne le drapeau (`port`, `authentication`,
 * `max-connections`, `access-class`, `timeout-policy`) était refusée.
 *
 * Ce magasin-ci porte les six faits ensemble parce qu'ils décrivent UN
 * serveur : un booléen seul ne peut pas dire sur quel port ni pour qui.
 * Les deux entrées correspondantes sont retirées de `CiscoConfigState`
 * plutôt que laissées à côté — deux magasins pour le même fait est
 * précisément le défaut que ce dépôt referme ailleurs.
 *
 * Défauts : le serveur est ARRÊTÉ au démarrage. C'est ce qu'écrit la
 * documentation Cisco pour IOS 15 (« The HTTP/HTTPS server is disabled
 * by default ») et ce que la table de drapeaux disait déjà ; le PRD des
 * accès affirmait l'inverse, et c'est lui qui avait tort.
 */

/** Méthode d'authentification du serveur (`ip http authentication`). */
export type HttpAuthMethod = 'enable' | 'local' | 'aaa' | 'tacacs';

export const HTTP_AUTH_METHODS: readonly HttpAuthMethod[] =
  Object.freeze(['enable', 'local', 'aaa', 'tacacs']);

/**
 * `ip http timeout-policy idle <s> life <s> requests <n>`. Les deux
 * délais sont ceux que rend une machine réelle (capture ntc-templates :
 * « Server idle time-out: 180 seconds », « Server life time-out: 180
 * seconds ») ; `requests` vaut 1 sur l'IOS classique.
 */
export interface HttpTimeoutPolicy {
  readonly idleSec: number;
  readonly lifeSec: number;
  readonly requests: number;
}

export const HTTP_DEFAULT_PORT = 80;
export const HTTP_DEFAULT_SECURE_PORT = 443;
export const HTTP_DEFAULT_MAX_CONNECTIONS = 5;
export const HTTP_MAX_CONNECTIONS_MIN = 1;
export const HTTP_MAX_CONNECTIONS_MAX = 16;

const DEFAULT_TIMEOUT_POLICY: HttpTimeoutPolicy =
  Object.freeze({ idleSec: 180, lifeSec: 180, requests: 1 });

export class CiscoHttpService {
  private _enabled = false;
  private _secureEnabled = false;
  private _port = HTTP_DEFAULT_PORT;
  private _securePort = HTTP_DEFAULT_SECURE_PORT;
  private _authMethod: HttpAuthMethod = 'enable';
  private _authListName: string | null = null;
  private _maxConnections = HTTP_DEFAULT_MAX_CONNECTIONS;
  private _accessClass: string | null = null;
  private _timeoutPolicy: HttpTimeoutPolicy = DEFAULT_TIMEOUT_POLICY;
  private _trustpoint: string | null = null;

  get enabled(): boolean { return this._enabled; }
  get secureEnabled(): boolean { return this._secureEnabled; }
  get port(): number { return this._port; }
  get securePort(): number { return this._securePort; }
  get authMethod(): HttpAuthMethod { return this._authMethod; }
  get authListName(): string | null { return this._authListName; }
  get maxConnections(): number { return this._maxConnections; }
  get accessClass(): string | null { return this._accessClass; }
  get timeoutPolicy(): HttpTimeoutPolicy { return this._timeoutPolicy; }
  get trustpoint(): string | null { return this._trustpoint; }

  setEnabled(on: boolean): void { this._enabled = on; }

  /**
   * IOS fabrique un point de confiance auto-signé (`TP-self-signed-<n>`)
   * la première fois que le serveur sécurisé démarre, et le garde
   * ensuite — c'est ce que rend `show ip http server status` sur une
   * machine réelle. Le fabriquer ici plutôt qu'à chaque démarrage évite
   * qu'un `no` suivi d'un `ip http secure-server` présente un certificat
   * différent, ce qu'un opérateur lirait comme une attaque.
   */
  setSecureEnabled(on: boolean, serialSeed?: string): void {
    this._secureEnabled = on;
    if (on && this._trustpoint === null) {
      this._trustpoint = `TP-self-signed-${selfSignedSerial(serialSeed ?? '')}`;
    }
  }

  setPort(port: number): void { this._port = port; }
  setSecurePort(port: number): void { this._securePort = port; }

  setAuthMethod(method: HttpAuthMethod, listName?: string): void {
    this._authMethod = method;
    this._authListName = listName ?? null;
  }

  setMaxConnections(n: number): void { this._maxConnections = n; }
  setAccessClass(acl: string | null): void { this._accessClass = acl; }
  setTimeoutPolicy(policy: HttpTimeoutPolicy): void { this._timeoutPolicy = policy; }

  resetAuthMethod(): void { this._authMethod = 'enable'; this._authListName = null; }
  resetTimeoutPolicy(): void { this._timeoutPolicy = DEFAULT_TIMEOUT_POLICY; }

  /**
   * Les lignes de `show running-config` : seules celles qui s'écartent
   * du défaut, comme IOS. Ce qui est rendu doit pouvoir être RETAPÉ tel
   * quel, puisque c'est ce que l'import d'une topologie rejoue.
   */
  runningConfigLines(): string[] {
    const out: string[] = [];
    if (this._enabled) out.push('ip http server');
    if (this._authMethod !== 'enable') {
      out.push(this._authListName
        ? `ip http authentication ${this._authMethod} ${this._authListName}`
        : `ip http authentication ${this._authMethod}`);
    }
    if (this._port !== HTTP_DEFAULT_PORT) out.push(`ip http port ${this._port}`);
    if (this._accessClass !== null) out.push(`ip http access-class ${this._accessClass}`);
    if (this._maxConnections !== HTTP_DEFAULT_MAX_CONNECTIONS) {
      out.push(`ip http max-connections ${this._maxConnections}`);
    }
    const t = this._timeoutPolicy;
    if (t.idleSec !== DEFAULT_TIMEOUT_POLICY.idleSec
      || t.lifeSec !== DEFAULT_TIMEOUT_POLICY.lifeSec
      || t.requests !== DEFAULT_TIMEOUT_POLICY.requests) {
      out.push(`ip http timeout-policy idle ${t.idleSec} life ${t.lifeSec} requests ${t.requests}`);
    }
    if (this._secureEnabled) out.push('ip http secure-server');
    if (this._securePort !== HTTP_DEFAULT_SECURE_PORT) {
      out.push(`ip http secure-port ${this._securePort}`);
    }
    return out;
  }

  /**
   * `show ip http server status`. La mise en forme vient d'une capture
   * réelle (jeu `ntc-templates`, `cisco_ios/show_ip_http_server_status`)
   * et non d'un exemple de documentation.
   *
   * Trois familles de lignes de cette capture sont DÉLIBÉRÉMENT absentes,
   * pour la raison qui vaut déjà pour `show ip ssh` : elles décriraient
   * un mécanisme qui n'a pas lieu ici. La liste de suites cryptographiques
   * et la courbe ECDHE (ce moteur TLS choisit les siennes, les annoncer
   * serait décrire une négociation inventée), l'algorithme de condensé et
   * `auth-retry`/`time-window` (aucune authentification digest, aucun
   * compteur de tentatives sur ce serveur), et le téléversement de
   * fichiers (`HTTP File Upload`, `upload path`, `help root`) qui n'existe
   * pas. La version TLS, elle, EST rendue parce qu'elle est vraie et
   * mesurable : ce moteur est un TLS 1.3 (RFC 8446).
   */
  statusLines(): string[] {
    const out = [
      `HTTP server status: ${this._enabled ? 'Enabled' : 'Disabled'}`,
      `HTTP server port: ${this._port}`,
      `HTTP server authentication method: ${this._authMethod}`,
      `HTTP server access class: ${this._accessClass ?? '0'}`,
      'HTTP server base path: ',
      `Maximum number of concurrent server connections allowed: ${this._maxConnections}`,
      `Server idle time-out: ${this._timeoutPolicy.idleSec} seconds`,
      `Server life time-out: ${this._timeoutPolicy.lifeSec} seconds`,
      `Maximum number of requests allowed on a connection: ${this._timeoutPolicy.requests}`,
      'HTTP server active session modules: ALL',
      'HTTP secure server capability: Present',
      `HTTP secure server status: ${this._secureEnabled ? 'Enabled' : 'Disabled'}`,
      `HTTP secure server port: ${this._securePort}`,
      'HTTP secure server TLS version:  TLSv1.3',
      `HTTP secure server trustpoint: ${this._trustpoint ?? ''}`,
      'HTTP secure server active session modules: ALL',
    ];
    return out;
  }
}

/**
 * IOS numérote son point de confiance auto-signé avec un entier tiré de
 * l'identité de la machine. Il est DÉRIVÉ du nom plutôt que tiré au sort
 * pour qu'une même machine retrouve le même nom d'un import à l'autre —
 * un nom qui changerait tout seul rendrait la configuration illisible.
 */
function selfSignedSerial(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return String(h === 0 ? 4212509801 : h);
}
