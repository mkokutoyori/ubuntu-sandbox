/**
 * `OnCalendar=` — les événements calendaires de `systemd.time(7)`.
 *
 * `TimerScheduler` ne connaissait que trois mots : `minutely`, `hourly`,
 * `daily`. Tout le reste rendait `null`, donc pas de prochaine échéance,
 * donc un timer armé, affiché, et qui ne partait jamais. Or la forme
 * normale d'un timer systemd est justement une expression calendaire —
 * les unités livrées par Ubuntu écrivent `*-*-* 6,18:00`, `weekly`,
 * `Sun *-*-* 03:10:00`.
 *
 * Grammaire, telle que `systemd-analyze calendar` la normalise :
 *
 *     [jour-de-semaine] [année-mois-jour] heure:minute[:seconde]
 *
 * Chaque champ accepte `*`, une valeur, une liste `1,2`, un intervalle
 * `8..14`, et un pas `début/incrément`. Une expression sans `-` ni `:`
 * n'est pas une date : `15,45` seul est refusé, comme par le vrai.
 *
 * Les formes attendues et les échéances calculées ici ont été relevées
 * sur `systemd-analyze calendar` (systemd de la machine de mesure), pas
 * déduites de la page de manuel.
 */

/** Un champ : `null` vaut « n'importe quelle valeur ». */
type Field = ReadonlySet<number> | null;

export interface CalendarSpec {
  weekdays: Field;
  years: Field;
  months: Field;
  days: Field;
  hours: Field;
  minutes: Field;
  seconds: Field;
}

const DOW: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Les raccourcis, avec la forme vers laquelle le vrai les développe.
 * `weekly` n'est pas « tous les sept jours » mais « le lundi à minuit ».
 */
const SHORTHANDS: Record<string, string> = {
  minutely: '*-*-* *:*:00',
  hourly: '*-*-* *:00:00',
  daily: '*-*-* 00:00:00',
  weekly: 'Mon *-*-* 00:00:00',
  monthly: '*-*-01 00:00:00',
  yearly: '*-01-01 00:00:00',
  annually: '*-01-01 00:00:00',
  quarterly: '*-01,04,07,10-01 00:00:00',
  semiannually: '*-01,07-01 00:00:00',
};

/** Développe `*`, `a,b`, `a..b` et `début/pas` sur les bornes du champ. */
function parseField(raw: string, min: number, max: number): Field | undefined {
  const text = raw.trim();
  if (text === '' ) return undefined;
  if (text === '*') return null;
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [rangePart, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('..')) {
      const [a, b] = rangePart.split('..');
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
    } else {
      lo = Number.parseInt(rangePart, 10);
      // `0/15` veut dire « à partir de 0, tous les quarts d'heure » —
      // le pas court jusqu'au bout du champ, pas jusqu'à la valeur seule.
      hi = stepRaw === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      return undefined;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : undefined;
}

function parseWeekdays(raw: string): Field | undefined {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === '') return undefined;
    if (token.includes('..')) {
      const [a, b] = token.split('..');
      const lo = DOW[a];
      const hi = DOW[b];
      if (lo === undefined || hi === undefined) return undefined;
      // `Sat..Sun` enjambe la fin de semaine : on tourne.
      for (let d = lo; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === hi) break;
      }
      continue;
    }
    const d = DOW[token];
    if (d === undefined) return undefined;
    out.add(d);
  }
  return out.size > 0 ? out : undefined;
}

/** Analyse une expression `OnCalendar=`. Rend `null` si elle est invalide. */
export function parseCalendar(expression: string): CalendarSpec | null {
  const trimmed = expression.trim();
  if (trimmed === '') return null;
  const expanded = SHORTHANDS[trimmed.toLowerCase()] ?? trimmed;

  let rest = expanded;
  let weekdays: Field = null;

  // Un premier mot qui n'est ni une date ni une heure est un jour de
  // semaine — c'est ainsi que `Mon..Fri 09:00` se distingue de `09:00`.
  const firstSpace = rest.indexOf(' ');
  if (firstSpace > 0) {
    const head = rest.slice(0, firstSpace);
    if (!head.includes(':') && /[a-z]/i.test(head)) {
      const parsed = parseWeekdays(head);
      if (parsed === undefined) return null;
      weekdays = parsed;
      rest = rest.slice(firstSpace + 1).trim();
    }
  }

  const parts = rest.split(/\s+/).filter((p) => p !== '');
  let datePart: string | null = null;
  let timePart: string | null = null;
  if (parts.length === 2) {
    [datePart, timePart] = parts;
  } else if (parts.length === 1) {
    // `03:00` est une heure ; `2026-01-01` est une date ; `15,45` n'est
    // ni l'un ni l'autre et le vrai le refuse.
    if (parts[0].includes(':')) timePart = parts[0];
    else if (parts[0].includes('-')) datePart = parts[0];
    else return null;
  } else {
    return null;
  }

  let years: Field = null;
  let months: Field = null;
  let days: Field = null;
  if (datePart !== null) {
    const d = datePart.split('-');
    if (d.length !== 3) return null;
    const y = parseField(d[0], 1970, 2200);
    const m = parseField(d[1], 1, 12);
    const dd = parseField(d[2], 1, 31);
    if (y === undefined || m === undefined || dd === undefined) return null;
    years = y; months = m; days = dd;
  }

  let hours: Field = new Set([0]);
  let minutes: Field = new Set([0]);
  let seconds: Field = new Set([0]);
  if (timePart !== null) {
    const t = timePart.split(':');
    if (t.length < 2 || t.length > 3) return null;
    const h = parseField(t[0], 0, 23);
    const mi = parseField(t[1], 0, 59);
    // Une heure écrite sans seconde tombe sur la seconde zéro.
    const s = t.length === 3 ? parseField(t[2], 0, 60) : new Set([0]);
    if (h === undefined || mi === undefined || s === undefined) return null;
    hours = h; minutes = mi; seconds = s;
  }

  return { weekdays, years, months, days, hours, minutes, seconds };
}

function matches(field: Field, value: number): boolean {
  return field === null || field.has(value);
}

function smallest(field: Field, min: number, max: number, above: number): number | null {
  for (let v = Math.max(min, above); v <= max; v++) {
    if (matches(field, v)) return v;
  }
  return null;
}

/**
 * La prochaine échéance strictement après `after`, ou `null` si elle
 * n'arrive jamais — une date fixe déjà passée, par exemple, ce que le
 * vrai affiche « never ».
 *
 * Le parcours va de jour en jour : les champs de temps sont trop fins
 * pour être balayés seconde par seconde, et une année de dates candidates
 * se compte en centaines d'essais. La borne de cinq ans est arbitraire
 * mais couvre tout ce qu'un timer réel exprime.
 */
export function nextCalendarElapse(spec: CalendarSpec, after: Date): Date | null {
  const HORIZON_DAYS = 366 * 5;
  const cursor = new Date(after.getTime());
  cursor.setMilliseconds(0);

  for (let day = 0; day <= HORIZON_DAYS; day++) {
    const probe = new Date(cursor.getTime());
    probe.setDate(probe.getDate() + day);
    if (day > 0) probe.setHours(0, 0, 0, 0);

    if (!matches(spec.years, probe.getFullYear())) continue;
    if (!matches(spec.months, probe.getMonth() + 1)) continue;
    if (!matches(spec.days, probe.getDate())) continue;
    if (!matches(spec.weekdays, probe.getDay())) continue;

    // Le même jour, on ne peut pas remonter avant l'heure de départ.
    const floorH = day === 0 ? probe.getHours() : 0;
    for (let h = smallest(spec.hours, 0, 23, floorH); h !== null; h = smallest(spec.hours, 0, 23, h + 1)) {
      const floorM = day === 0 && h === probe.getHours() ? probe.getMinutes() : 0;
      for (let m = smallest(spec.minutes, 0, 59, floorM); m !== null; m = smallest(spec.minutes, 0, 59, m + 1)) {
        const sameMinute = day === 0 && h === probe.getHours() && m === probe.getMinutes();
        const floorS = sameMinute ? probe.getSeconds() + 1 : 0;
        const s = smallest(spec.seconds, 0, 59, floorS);
        if (s === null) continue;
        const found = new Date(probe.getTime());
        found.setHours(h, m, s, 0);
        if (found.getTime() > after.getTime()) return found;
      }
    }
  }
  return null;
}

/** Raccourci : analyse puis calcule, pour les appelants qui ont la chaîne. */
export function nextElapseOf(expression: string | undefined, after: Date): Date | null {
  if (!expression) return null;
  const spec = parseCalendar(expression);
  return spec === null ? null : nextCalendarElapse(spec, after);
}
