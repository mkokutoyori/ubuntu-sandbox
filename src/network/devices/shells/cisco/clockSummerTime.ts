export const SUMMER_TIME_OFFSET_RANGE: readonly [number, number] = [1, 1440];
export const SUMMER_TIME_YEAR_RANGE: readonly [number, number] = [1993, 2035];

const MOIS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const JOURS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const HEURE = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;

function estMois(mot: string): boolean {
  return MOIS.includes(mot.slice(0, 3).toLowerCase());
}

function estJour(mot: string): boolean {
  return JOURS.includes(mot.slice(0, 3).toLowerCase());
}

function estSemaine(mot: string): boolean {
  const bas = mot.toLowerCase();
  if (bas === 'first' || bas === 'last') return true;
  return /^[1-5]$/.test(mot);
}

function estEntierDans(mot: string, [min, max]: readonly [number, number]): boolean {
  if (!/^\d+$/.test(mot)) return false;
  const n = Number(mot);
  return n >= min && n <= max;
}

export interface SummerTimeRule {
  readonly kind: 'recurring' | 'date';
  readonly start: string;
  readonly end: string;
  readonly offsetMin?: number;
}

export interface SummerTimeParse {
  readonly rule: SummerTimeRule | null;
  readonly badToken?: string;
}

function lireBorneRecurrente(mots: readonly string[]): boolean {
  return mots.length === 4 && estSemaine(mots[0]) && estJour(mots[1])
    && estMois(mots[2]) && HEURE.test(mots[3]);
}

function lireBorneDatee(mots: readonly string[]): boolean {
  if (mots.length !== 4 || !HEURE.test(mots[3])) return false;
  if (!estEntierDans(mots[2], SUMMER_TIME_YEAR_RANGE)) return false;
  const jourPuisMois = estEntierDans(mots[0], [1, 31]) && estMois(mots[1]);
  const moisPuisJour = estMois(mots[0]) && estEntierDans(mots[1], [1, 31]);
  return jourPuisMois || moisPuisJour;
}

export function parseSummerTimeRule(mots: readonly string[]): SummerTimeParse {
  if (mots.length === 0) return { rule: null };

  const genre = mots[0].toLowerCase();
  if (genre !== 'recurring' && genre !== 'date') {
    return { rule: null, badToken: mots[0] };
  }

  const reste = mots.slice(1);
  if (reste.length === 0) {
    if (genre === 'date') return { rule: null, badToken: mots[0] };
    return { rule: { kind: 'recurring', start: '', end: '' } };
  }

  if (reste.length !== 8 && reste.length !== 9) {
    return { rule: null, badToken: reste[reste.length - 1] };
  }

  const debut = reste.slice(0, 4);
  const fin = reste.slice(4, 8);
  const lire = genre === 'recurring' ? lireBorneRecurrente : lireBorneDatee;
  if (!lire(debut)) {
    return { rule: null, badToken: debut.find((m) => !HEURE.test(m)) ?? debut[0] };
  }
  if (!lire(fin)) {
    return { rule: null, badToken: fin.find((m) => !HEURE.test(m)) ?? fin[0] };
  }

  if (reste.length === 9) {
    if (!estEntierDans(reste[8], SUMMER_TIME_OFFSET_RANGE)) {
      return { rule: null, badToken: reste[8] };
    }
    return {
      rule: {
        kind: genre, start: debut.join(' '), end: fin.join(' '),
        offsetMin: Number(reste[8]),
      },
    };
  }
  return { rule: { kind: genre, start: debut.join(' '), end: fin.join(' ') } };
}
