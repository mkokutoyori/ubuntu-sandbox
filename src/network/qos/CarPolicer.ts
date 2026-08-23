/**
 * CAR — `rate-limit` de l'IOS historique, avec un vrai seau à jetons.
 *
 * La commande était acceptée, jetée, et sans vue. La corriger en la
 * stockant et en l'affichant avec des compteurs à zéro aurait été un
 * décor : ce fichier POLICE réellement, sur le chemin des paquets, et
 * les compteurs de `show interfaces … rate-limit` sont donc une mesure.
 *
 * Le modèle est celui de Cisco (`rate-limit {input|output} <bps>
 * <rafale-normale> <rafale-max> conform-action A exceed-action B`) :
 *
 *  - le seau se remplit de `bps / 8` octets par seconde, et déborde à
 *    `rafale-normale` octets. Un lien inactif accumule donc du crédit
 *    jusqu'à cette limite, ce qui est exactement ce que « rafale »
 *    veut dire ;
 *  - un paquet qui trouve assez de jetons est CONFORME et les
 *    consomme ; sinon il est EN EXCÈS et n'en consomme aucun ;
 *  - la rafale MAXIMALE de Cisco sert au comportement intermédiaire
 *    (`exceed-action` probabiliste entre les deux seuils). Elle est
 *    mémorisée et rendue, mais le tirage aléatoire n'est pas fait :
 *    un simulateur pédagogique dont le même trafic donne un résultat
 *    différent à chaque exécution serait ininterprétable, et un test ne
 *    pourrait rien en affirmer. Le seuil retenu est donc la rafale
 *    normale, ce qui rend la police déterministe et reproductible.
 *
 * Les actions modélisées sont celles qui changent le sort du paquet :
 * `transmit` le laisse passer, `drop` le jette. `continue` et les
 * `set-*-transmit` sont acceptées à la configuration et traitées comme
 * un passage, faute de champ de priorité conservé de bout en bout dans
 * ce plan de données — écrit ici plutôt que découvert.
 */

export type CarDirection = 'input' | 'output';
export type CarAction = 'transmit' | 'drop' | 'continue' | string;

export interface CarRule {
  direction: CarDirection;
  bitsPerSecond: number;
  normalBurstBytes: number;
  maxBurstBytes: number;
  conformAction: CarAction;
  exceedAction: CarAction;
  /** La ligne telle que l'opérateur l'a écrite (running-config). */
  raw: string;
  // ── État du seau et mesures ──
  tokens: number;
  lastRefillMs: number;
  conformedPackets: number;
  conformedBytes: number;
  exceededPackets: number;
  exceededBytes: number;
  lastPacketMs: number | null;
}

/**
 * `rate-limit output 8000 1500 3000 conform-action transmit exceed-action drop`
 * Rend `null` si la ligne n'a pas la forme attendue — l'appelant refuse
 * alors la commande au lieu de stocker une règle inerte.
 */
export function parseRateLimitRule(args: string[], raw: string): CarRule | null {
  const dir = (args[0] ?? '').toLowerCase();
  if (dir !== 'input' && dir !== 'output') return null;
  const bps = parseInt(args[1] ?? '', 10);
  const normal = parseInt(args[2] ?? '', 10);
  const max = parseInt(args[3] ?? '', 10);
  if (!Number.isFinite(bps) || !Number.isFinite(normal) || !Number.isFinite(max)) return null;
  if (bps <= 0 || normal <= 0 || max < normal) return null;

  const lire = (mot: string): string | null => {
    const i = args.indexOf(mot);
    return i >= 0 && args[i + 1] ? args[i + 1].toLowerCase() : null;
  };
  const conform = lire('conform-action');
  const exceed = lire('exceed-action');
  if (!conform || !exceed) return null;

  return {
    direction: dir, bitsPerSecond: bps,
    normalBurstBytes: normal, maxBurstBytes: max,
    conformAction: conform, exceedAction: exceed, raw,
    tokens: normal, lastRefillMs: Date.now(),
    conformedPackets: 0, conformedBytes: 0,
    exceededPackets: 0, exceededBytes: 0, lastPacketMs: null,
  };
}

export function parseVrpCarRule(args: string[], raw: string): CarRule | null {
  const dir = (args[0] ?? '').toLowerCase();
  if (dir !== 'inbound' && dir !== 'outbound') return null;
  return parseCarParameters(args, raw, dir === 'inbound' ? 'input' : 'output');
}

/**
 * `car cir …` sous `traffic behavior` : les memes parametres, sans
 * direction — celle-ci vient du point ou la politique est appliquee.
 */
export function parseMqcCarRule(
  args: string[], raw: string, direction: CarDirection,
): CarRule | null {
  return parseCarParameters(args, raw, direction);
}

function parseCarParameters(
  args: string[], raw: string, direction: CarDirection,
): CarRule | null {
  const lireNombre = (mot: string): number | null => {
    const i = args.indexOf(mot);
    if (i < 0 || !args[i + 1]) return null;
    const n = parseInt(args[i + 1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const cirKbps = lireNombre('cir');
  if (cirKbps === null) return null;
  const pirKbps = lireNombre('pir');
  if (pirKbps !== null && pirKbps < cirKbps) return null;
  const bitsPerSecond = cirKbps * 1000;
  const cbs = lireNombre('cbs') ?? Math.max(1, Math.round(bitsPerSecond / 8 / 8));
  const pbs = lireNombre('pbs') ?? cbs * 2;
  if (pbs < cbs) return null;
  return {
    direction,
    bitsPerSecond, normalBurstBytes: cbs, maxBurstBytes: pbs,
    conformAction: 'transmit', exceedAction: 'drop', raw,
    tokens: cbs, lastRefillMs: Date.now(),
    conformedPackets: 0, conformedBytes: 0,
    exceededPackets: 0, exceededBytes: 0, lastPacketMs: null,
  };
}

/** Une action laisse-t-elle passer le paquet ? */
export function actionTransmits(a: CarAction): boolean {
  return a !== 'drop';
}

/**
 * Les règles CAR d'une interface, et la décision qu'elles prennent.
 *
 * Une interface peut porter plusieurs `rate-limit` ; IOS les évalue
 * dans l'ordre de configuration et s'arrête à la première qui
 * s'applique, ce que reproduit `police()`.
 */
export class CarPolicer {
  private readonly rules: CarRule[] = [];

  add(rule: CarRule): void { this.rules.push(rule); }
  list(): readonly CarRule[] { return this.rules; }
  isEmpty(): boolean { return this.rules.length === 0; }
  clear(): void { this.rules.length = 0; }

  /**
   * Rend `true` si le paquet peut continuer, `false` s'il est jeté.
   * `now` est injectable pour que les tests mesurent le remplissage du
   * seau sans dépendre de l'horloge murale.
   */
  police(direction: CarDirection, bytes: number, now: number = Date.now()): boolean {
    for (const r of this.rules) {
      if (r.direction !== direction) continue;
      this.refill(r, now);
      r.lastPacketMs = now;
      if (r.tokens >= bytes) {
        r.tokens -= bytes;
        r.conformedPackets++;
        r.conformedBytes += bytes;
        return actionTransmits(r.conformAction);
      }
      r.exceededPackets++;
      r.exceededBytes += bytes;
      return actionTransmits(r.exceedAction);
    }
    return true;
  }

  private refill(r: CarRule, now: number): void {
    const ecouleMs = Math.max(0, now - r.lastRefillMs);
    if (ecouleMs === 0) return;
    r.tokens = Math.min(
      r.normalBurstBytes,
      r.tokens + (r.bitsPerSecond / 8) * (ecouleMs / 1000),
    );
    r.lastRefillMs = now;
  }
}

export type SuppressionKind = 'broadcast' | 'multicast' | 'unicast';

export const SUPPRESSION_KINDS: readonly SuppressionKind[] =
  Object.freeze(['broadcast', 'multicast', 'unicast']);

export function parseSuppressionRule(
  kind: SuppressionKind, args: readonly string[], bandwidthKbps: number, raw: string,
): CarRule | null {
  if (args.length !== 1) return null;
  const percent = Number.parseInt(args[0] ?? '', 10);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;

  const bitsPerSecond = Math.round((bandwidthKbps * 1000 * percent) / 100);
  const normalBurstBytes = Math.max(1, Math.round(bitsPerSecond / 8 / 8));
  return {
    direction: 'input',
    bitsPerSecond, normalBurstBytes, maxBurstBytes: normalBurstBytes * 2,
    conformAction: 'transmit', exceedAction: 'drop', raw,
    tokens: percent === 0 ? 0 : normalBurstBytes, lastRefillMs: Date.now(),
    conformedPackets: 0, conformedBytes: 0,
    exceededPackets: 0, exceededBytes: 0, lastPacketMs: null,
  };
}

export function suppressionKindOf(dstMac: string): SuppressionKind {
  const upper = dstMac.toUpperCase();
  if (upper === 'FF:FF:FF:FF:FF:FF') return 'broadcast';
  const first = Number.parseInt(upper.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 1) === 1 ? 'multicast' : 'unicast';
}

/** Une copie NEUVE d'une regle : son seau lui appartient. */
export function cloneCarRule(rule: CarRule, now = Date.now()): CarRule {
  return {
    ...rule,
    tokens: rule.normalBurstBytes, lastRefillMs: now,
    conformedPackets: 0, conformedBytes: 0,
    exceededPackets: 0, exceededBytes: 0, lastPacketMs: null,
  };
}
