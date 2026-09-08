import { renderTable, type TableStyle } from '../shells/cli/TextTable';
import { findWmiClass, type WmiHost, type WmiRow } from './WmiClasses';

export type { WmiHost as WmicHost };

const WMIC_TABLE: TableStyle = { gap: 0, rule: false, padTrailing: true };

function invalidQuery(host: WmiHost): string {
  return [`Node - ${host.hostname.toUpperCase()}`, 'ERROR:', 'Description = Invalid query'].join('\n');
}

/**
 * Les colonnes que WMIC rend sont celles qu'on lui demande, RANGEES par
 * nom de propriete — `get size,model,serialnumber` sort `Model`,
 * `SerialNumber`, `Size`. Une propriete que la classe ne porte pas fait
 * echouer la requete entiere, elle n'est pas ignoree ; et un alias que
 * WMI ne connait pas est REFUSE plutot que rendu vide.
 */
export function wmicQuery(host: WmiHost, alias: string, asked: readonly string[]): string | null {
  const klass = findWmiClass(alias);
  if (!klass) return null;

  const wanted = asked.length === 0 ? [...klass.properties] : asked.map((a) => {
    const match = klass.properties.find((p) => p.toLowerCase() === a.toLowerCase());
    return match ?? '';
  });
  if (wanted.some((w) => w === '')) return invalidQuery(host);

  const selected = [...wanted].sort((a, b) => a.localeCompare(b));
  const rows = klass.rows(host);
  const columns = selected.map((property) => ({
    header: property,
    value: (row: WmiRow) => row[property] ?? '',
    width: Math.max(property.length, ...rows.map((r) => (r[property] ?? '').length)) + 2,
  }));
  return renderTable(rows, columns, WMIC_TABLE).join('\n');
}

/** Ce qu'un vrai WMIC repond quand le premier mot n'est pas une classe. */
export function aliasNotFound(alias: string): string {
  return `${alias} Alias not found!`;
}

export function parseWmicProperties(tokens: readonly string[]): string[] {
  return tokens.join(' ').split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}
