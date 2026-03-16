/**
 * PSPipeline — Object-based PowerShell pipeline engine.
 *
 * Real PowerShell passes typed objects between pipeline stages, not strings.
 * This module provides:
 *   - PSObject: lightweight property bag representing a .NET-like object
 *   - Pipeline stages: Where-Object, Select-Object, Sort-Object,
 *     Measure-Object, Select-String, Format-Table, Format-List
 *   - Script block condition parser for Where-Object
 *   - Table parser to extract PSObjects from pre-formatted string output
 *
 * Design:
 *   Cmdlets can return PSObject[] for structured pipeline processing.
 *   When piped, stages transform the array. The final stage (or default
 *   formatter) converts back to a display string.
 */

// ─── Core types ──────────────────────────────────────────────────

export type PSValue = string | number | boolean | null;

export interface PSObject {
  [key: string]: PSValue;
}

// ─── Table parsing (string → PSObject[]) ─────────────────────────

/**
 * Parse a pre-formatted table string (with header + dashes separator)
 * into PSObject[].
 *
 * Handles tables like:
 *   Name        Value
 *   ----        -----
 *   foo         42
 *   bar         hello
 *
 * Column boundaries are detected from the dash-separator line.
 */
export function parseTable(text: string): PSObject[] | null {
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) return null;

  // Find the header + separator pair
  let headerIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^[\s-]+$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return null;

  const headerLine = lines[headerIdx];
  const sepLine = lines[headerIdx + 1];

  // Detect column boundaries from separator dashes
  const columns: Array<{ name: string; start: number; end: number }> = [];
  const dashRegex = /(-+)/g;
  let match: RegExpExecArray | null;
  while ((match = dashRegex.exec(sepLine)) !== null) {
    const start = match.index;
    const end = start + match[1].length;
    const name = headerLine.substring(start, end).trim();
    if (name) {
      columns.push({ name, start, end });
    }
  }
  if (columns.length === 0) return null;

  // Parse data rows
  const objects: PSObject[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const obj: PSObject = {};
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      const isLast = c === columns.length - 1;
      const raw = isLast
        ? line.substring(col.start).trim()
        : line.substring(col.start, columns[c + 1].start).trim();
      obj[col.name] = coerceValue(raw);
    }
    objects.push(obj);
  }

  return objects.length > 0 ? objects : null;
}

/**
 * Parse key-value formatted output (Format-List style) into PSObject[].
 *
 * Handles blocks like:
 *   Name  : foo
 *   Value : 42
 *
 *   Name  : bar
 *   Value : hello
 */
export function parseKeyValueBlocks(text: string): PSObject[] | null {
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  if (blocks.length === 0) return null;

  const objects: PSObject[] = [];
  for (const block of blocks) {
    const obj: PSObject = {};
    let hasProps = false;
    for (const line of block.split('\n')) {
      const match = line.match(/^(\S.*?)\s*:\s*(.*)$/);
      if (match) {
        obj[match[1].trim()] = coerceValue(match[2].trim());
        hasProps = true;
      }
    }
    if (hasProps) objects.push(obj);
  }

  return objects.length > 0 ? objects : null;
}

function coerceValue(raw: string): PSValue {
  if (raw === '' || raw === 'null' || raw === '$null') return null;
  if (raw === 'True' || raw === 'true' || raw === '$true') return true;
  if (raw === 'False' || raw === 'false' || raw === '$false') return false;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== '') return num;
  return raw;
}

// ─── Where-Object condition parser ───────────────────────────────

/**
 * Parse a Where-Object script block or simplified syntax.
 *
 * Supported forms:
 *   { $_.Property -eq 'value' }
 *   { $_.Property -ne value }
 *   { $_.Property -like '*pattern*' }
 *   { $_.Property -notlike '*pattern*' }
 *   { $_.Property -match 'regex' }
 *   { $_.Property -notmatch 'regex' }
 *   { $_.Property -gt number }
 *   { $_.Property -ge number }
 *   { $_.Property -lt number }
 *   { $_.Property -le number }
 *   { $_.Property -contains value }
 *   { $_.Property }                  (truthy check)
 *
 * Also simplified syntax:
 *   -Property Name -eq 'value'
 *   Where-Object Property -eq 'value'
 */
export type WhereCondition = (obj: PSObject) => boolean;

export function parseWhereCondition(filterArgs: string): WhereCondition {
  // Remove surrounding braces if present
  let expr = filterArgs.trim();
  if (expr.startsWith('{') && expr.endsWith('}')) {
    expr = expr.slice(1, -1).trim();
  }

  // Parse: $_.Property -operator value
  const condMatch = expr.match(
    /^\$_\.(\w+)\s+(-eq|-ne|-like|-notlike|-match|-notmatch|-gt|-ge|-lt|-le|-contains|-notcontains)\s+(.+)$/i
  );
  if (condMatch) {
    const prop = condMatch[1];
    const op = condMatch[2].toLowerCase();
    let val = condMatch[3].trim().replace(/^['"]|['"]$/g, '');

    return (obj: PSObject) => {
      const objVal = obj[prop];
      return evaluateCondition(objVal, op, val);
    };
  }

  // Parse: $_.Property (truthy check)
  const truthyMatch = expr.match(/^\$_\.(\w+)$/);
  if (truthyMatch) {
    const prop = truthyMatch[1];
    return (obj: PSObject) => {
      const v = obj[prop];
      return v !== null && v !== false && v !== '' && v !== 0;
    };
  }

  // Simplified syntax: -Property Prop -operator value
  const simplifiedMatch = expr.match(
    /^(?:-Property\s+)?(\w+)\s+(-eq|-ne|-like|-notlike|-match|-notmatch|-gt|-ge|-lt|-le|-contains|-notcontains)\s+(.+)$/i
  );
  if (simplifiedMatch) {
    const prop = simplifiedMatch[1];
    const op = simplifiedMatch[2].toLowerCase();
    let val = simplifiedMatch[3].trim().replace(/^['"]|['"]$/g, '');

    return (obj: PSObject) => {
      const objVal = obj[prop];
      return evaluateCondition(objVal, op, val);
    };
  }

  // Fallback: always true (unknown condition)
  return () => true;
}

function evaluateCondition(objVal: PSValue, op: string, val: string): boolean {
  const strVal = String(objVal ?? '');
  const numObj = typeof objVal === 'number' ? objVal : parseFloat(strVal);
  const numVal = parseFloat(val);

  switch (op) {
    case '-eq':
      return strVal.toLowerCase() === val.toLowerCase();
    case '-ne':
      return strVal.toLowerCase() !== val.toLowerCase();
    case '-like':
      return wildcardMatch(strVal, val);
    case '-notlike':
      return !wildcardMatch(strVal, val);
    case '-match':
      try { return new RegExp(val, 'i').test(strVal); } catch { return false; }
    case '-notmatch':
      try { return !new RegExp(val, 'i').test(strVal); } catch { return true; }
    case '-gt':
      return !isNaN(numObj) && !isNaN(numVal) && numObj > numVal;
    case '-ge':
      return !isNaN(numObj) && !isNaN(numVal) && numObj >= numVal;
    case '-lt':
      return !isNaN(numObj) && !isNaN(numVal) && numObj < numVal;
    case '-le':
      return !isNaN(numObj) && !isNaN(numVal) && numObj <= numVal;
    case '-contains':
      return strVal.toLowerCase().includes(val.toLowerCase());
    case '-notcontains':
      return !strVal.toLowerCase().includes(val.toLowerCase());
    default:
      return true;
  }
}

function wildcardMatch(str: string, pattern: string): boolean {
  // Convert PS wildcard to regex: * → .*, ? → .
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(str);
}

// ─── Pipeline stages ─────────────────────────────────────────────

/** Where-Object: filter objects by condition. */
export function whereObject(objects: PSObject[], args: string): PSObject[] {
  const condition = parseWhereCondition(args);
  return objects.filter(condition);
}

/**
 * Select-Object: project properties or limit count.
 *
 * Supports:
 *   -Property Name, Id        (select specific properties)
 *   -First N                  (take first N)
 *   -Last N                   (take last N)
 *   -Skip N                   (skip first N)
 *   -ExpandProperty Name      (extract single property values)
 *   -Unique                   (deduplicate)
 */
export function selectObject(objects: PSObject[], args: string): PSObject[] {
  const tokens = tokenizeArgs(args);
  let properties: string[] | null = null;
  let first = -1, last = -1, skip = 0;
  let expandProp: string | null = null;
  let unique = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === '-property' && tokens[i + 1]) {
      // Collect comma-separated property names
      properties = [];
      i++;
      while (i < tokens.length && !tokens[i].startsWith('-')) {
        const names = tokens[i].split(',').map(s => s.trim()).filter(Boolean);
        properties.push(...names);
        i++;
      }
      i--; // back up for outer loop
    } else if (t === '-first' && tokens[i + 1]) {
      first = parseInt(tokens[++i], 10);
    } else if (t === '-last' && tokens[i + 1]) {
      last = parseInt(tokens[++i], 10);
    } else if (t === '-skip' && tokens[i + 1]) {
      skip = parseInt(tokens[++i], 10);
    } else if (t === '-expandproperty' && tokens[i + 1]) {
      expandProp = tokens[++i];
    } else if (t === '-unique') {
      unique = true;
    } else if (!t.startsWith('-') && !properties) {
      // Bare property names
      properties = tokens[i].split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  let result = objects;

  // Skip
  if (skip > 0) result = result.slice(skip);

  // First / Last
  if (first >= 0) result = result.slice(0, first);
  else if (last >= 0) result = result.slice(-last);

  // Expand property
  if (expandProp) {
    return result.map(obj => ({ [expandProp!]: obj[expandProp!] ?? null }));
  }

  // Property projection
  if (properties && properties.length > 0) {
    result = result.map(obj => {
      const projected: PSObject = {};
      for (const p of properties!) {
        // Case-insensitive property lookup
        const key = Object.keys(obj).find(k => k.toLowerCase() === p.toLowerCase()) || p;
        projected[p] = obj[key] ?? null;
      }
      return projected;
    });
  }

  // Unique
  if (unique) {
    const seen = new Set<string>();
    result = result.filter(obj => {
      const key = JSON.stringify(obj);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return result;
}

/**
 * Sort-Object: sort by one or more properties.
 *
 * Supports:
 *   -Property Name, Id
 *   -Descending
 */
export function sortObject(objects: PSObject[], args: string): PSObject[] {
  const tokens = tokenizeArgs(args);
  let properties: string[] = [];
  let descending = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === '-property' && tokens[i + 1]) {
      i++;
      while (i < tokens.length && !tokens[i].startsWith('-')) {
        properties.push(...tokens[i].split(',').map(s => s.trim()).filter(Boolean));
        i++;
      }
      i--;
    } else if (t === '-descending') {
      descending = true;
    } else if (!t.startsWith('-')) {
      properties.push(...tokens[i].split(',').map(s => s.trim()).filter(Boolean));
    }
  }

  const sorted = [...objects];

  if (properties.length === 0) {
    // Sort by string representation
    sorted.sort((a, b) => {
      const aStr = Object.values(a).join(' ');
      const bStr = Object.values(b).join(' ');
      return aStr.localeCompare(bStr);
    });
  } else {
    sorted.sort((a, b) => {
      for (const prop of properties) {
        const aKey = Object.keys(a).find(k => k.toLowerCase() === prop.toLowerCase()) || prop;
        const bKey = Object.keys(b).find(k => k.toLowerCase() === prop.toLowerCase()) || prop;
        const aVal = a[aKey];
        const bVal = b[bKey];
        const cmp = compareValues(aVal, bVal);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  if (descending) sorted.reverse();
  return sorted;
}

function compareValues(a: PSValue, b: PSValue): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Measure-Object: calculate statistics on numeric properties.
 *
 * Supports:
 *   -Property Name
 *   -Sum
 *   -Average
 *   -Minimum
 *   -Maximum
 *
 * When no flags given, only Count is returned.
 * When no property given, counts objects (or lines for string input).
 */
export function measureObject(objects: PSObject[], args: string): string {
  const tokens = tokenizeArgs(args);
  let property: string | null = null;
  let wantSum = false, wantAvg = false, wantMin = false, wantMax = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === '-property' && tokens[i + 1]) { property = tokens[++i]; }
    else if (t === '-sum') wantSum = true;
    else if (t === '-average') wantAvg = true;
    else if (t === '-minimum') wantMin = true;
    else if (t === '-maximum') wantMax = true;
    else if (!t.startsWith('-') && !property) property = tokens[i];
  }

  const count = objects.length;

  // If no property, just count
  if (!property) {
    const lines: string[] = [];
    lines.push(`Count    : ${count}`);
    if (wantAvg) lines.push('Average  : ');
    if (wantSum) lines.push('Sum      : ');
    if (wantMax) lines.push('Maximum  : ');
    if (wantMin) lines.push('Minimum  : ');
    lines.push('Property : ');
    return lines.join('\n');
  }

  // Extract numeric values for the property
  const values: number[] = [];
  for (const obj of objects) {
    const key = Object.keys(obj).find(k => k.toLowerCase() === property!.toLowerCase()) || property!;
    const val = obj[key];
    const num = typeof val === 'number' ? val : parseFloat(String(val ?? ''));
    if (!isNaN(num)) values.push(num);
  }

  const sum = values.reduce((a, b) => a + b, 0);
  const avg = values.length > 0 ? sum / values.length : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;

  const lines: string[] = [];
  lines.push(`Count    : ${count}`);
  if (wantAvg) lines.push(`Average  : ${avg}`);
  if (wantSum) lines.push(`Sum      : ${sum}`);
  if (wantMax) lines.push(`Maximum  : ${max}`);
  if (wantMin) lines.push(`Minimum  : ${min}`);
  lines.push(`Property : ${property}`);

  // If no specific flags, show all
  if (!wantSum && !wantAvg && !wantMin && !wantMax) {
    return [
      `Count    : ${count}`,
      `Average  : ${avg}`,
      `Sum      : ${sum}`,
      `Maximum  : ${max}`,
      `Minimum  : ${min}`,
      `Property : ${property}`,
    ].join('\n');
  }

  return lines.join('\n');
}

/**
 * Select-String: regex/substring filtering on text lines or object properties.
 *
 * Supports:
 *   -Pattern 'regex'
 *   -SimpleMatch (literal substring, no regex)
 *   -CaseSensitive
 *   -NotMatch (invert match)
 */
export function selectString(objects: PSObject[], args: string): PSObject[] {
  const tokens = tokenizeArgs(args);
  let pattern = '';
  let simpleMatch = false;
  let caseSensitive = false;
  let notMatch = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === '-pattern' && tokens[i + 1]) {
      pattern = tokens[++i].replace(/^['"]|['"]$/g, '');
    } else if (t === '-simplematch') {
      simpleMatch = true;
    } else if (t === '-casesensitive') {
      caseSensitive = true;
    } else if (t === '-notmatch') {
      notMatch = true;
    } else if (!t.startsWith('-') && !pattern) {
      pattern = tokens[i].replace(/^['"]|['"]$/g, '');
    }
  }

  if (!pattern) return objects;

  return objects.filter(obj => {
    // Search across all property values
    const text = Object.values(obj).map(v => String(v ?? '')).join(' ');
    let matches: boolean;

    if (simpleMatch) {
      matches = caseSensitive
        ? text.includes(pattern)
        : text.toLowerCase().includes(pattern.toLowerCase());
    } else {
      try {
        const flags = caseSensitive ? '' : 'i';
        matches = new RegExp(pattern, flags).test(text);
      } catch {
        matches = text.toLowerCase().includes(pattern.toLowerCase());
      }
    }

    return notMatch ? !matches : matches;
  });
}

// ─── Formatters ──────────────────────────────────────────────────

/**
 * Format-Table: format PSObject[] as an aligned table with headers.
 *
 * Supports:
 *   -Property Name, Id     (select/reorder columns)
 *   -AutoSize              (minimize column widths)
 */
export function formatTable(objects: PSObject[], args: string): string {
  if (objects.length === 0) return '';

  const tokens = tokenizeArgs(args);
  let properties: string[] | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === '-property' && tokens[i + 1]) {
      properties = [];
      i++;
      while (i < tokens.length && !tokens[i].startsWith('-')) {
        properties.push(...tokens[i].split(',').map(s => s.trim()).filter(Boolean));
        i++;
      }
      i--;
    } else if (t === '-autosize') {
      // AutoSize is the default behavior
    } else if (!t.startsWith('-') && !properties) {
      properties = tokens[i].split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  // Determine columns
  const columns = properties || Object.keys(objects[0]);

  // Calculate column widths
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
  }
  for (const obj of objects) {
    for (const col of columns) {
      const key = Object.keys(obj).find(k => k.toLowerCase() === col.toLowerCase()) || col;
      const val = String(obj[key] ?? '');
      widths[col] = Math.max(widths[col], val.length);
    }
  }

  // Build table
  const lines: string[] = [];
  const headerLine = columns.map(c => c.padEnd(widths[c])).join('  ');
  const sepLine = columns.map(c => '-'.repeat(widths[c])).join('  ');
  lines.push('');
  lines.push(headerLine);
  lines.push(sepLine);

  for (const obj of objects) {
    const row = columns.map(col => {
      const key = Object.keys(obj).find(k => k.toLowerCase() === col.toLowerCase()) || col;
      const val = String(obj[key] ?? '');
      // Right-align numbers
      if (typeof obj[key] === 'number') return val.padStart(widths[col]);
      return val.padEnd(widths[col]);
    }).join('  ');
    lines.push(row);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Format-List: format PSObject[] as key-value pairs.
 *
 * Supports:
 *   -Property Name, Id     (select properties)
 */
export function formatList(objects: PSObject[], args: string): string {
  if (objects.length === 0) return '';

  const tokens = tokenizeArgs(args);
  let properties: string[] | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === '-property' && tokens[i + 1]) {
      properties = [];
      i++;
      while (i < tokens.length && !tokens[i].startsWith('-')) {
        properties.push(...tokens[i].split(',').map(s => s.trim()).filter(Boolean));
        i++;
      }
      i--;
    } else if (!t.startsWith('-') && !properties) {
      properties = tokens[i].split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  const blocks: string[] = [];
  for (const obj of objects) {
    const keys = properties || Object.keys(obj);
    const maxKeyLen = Math.max(...keys.map(k => k.length));
    const pairs = keys.map(k => {
      const key = Object.keys(obj).find(ok => ok.toLowerCase() === k.toLowerCase()) || k;
      return `${k.padEnd(maxKeyLen)} : ${String(obj[key] ?? '')}`;
    });
    blocks.push(pairs.join('\n'));
  }

  return '\n' + blocks.join('\n\n') + '\n';
}

/**
 * Default formatter: use Format-Table for 4 or fewer properties,
 * Format-List for more (matches real PS behavior).
 */
export function formatDefault(objects: PSObject[]): string {
  if (objects.length === 0) return '';
  const propCount = Object.keys(objects[0]).length;
  if (propCount <= 4) return formatTable(objects, '');
  return formatList(objects, '');
}

// ─── Full pipeline execution ─────────────────────────────────────

export type PipelineInput = PSObject[] | string;

/**
 * Apply a pipeline stage filter to a set of objects.
 * If input is a string, tries to parse it as a table first.
 * Returns PSObject[] for further pipeline stages, or string for final output.
 */
export function applyPipelineStage(
  input: PipelineInput,
  filter: string,
): { output: PipelineInput; formatted?: string } {
  // Ensure we have PSObject[]
  let objects: PSObject[];
  if (typeof input === 'string') {
    const parsed = parseTable(input) ?? parseKeyValueBlocks(input);
    if (parsed) {
      objects = parsed;
    } else {
      // Fall back to line-based objects
      objects = input.split('\n')
        .filter(l => l.trim())
        .map(line => ({ Line: line }));
    }
  } else {
    objects = input;
  }

  const filterLower = filter.toLowerCase().trim();
  const args = extractFilterArgs(filter);

  // Where-Object
  if (filterLower.startsWith('where-object') || filterLower.startsWith('where ') || filterLower.startsWith('where{') || filterLower === 'where' || filterLower.startsWith('?')) {
    return { output: whereObject(objects, args) };
  }

  // Select-Object
  if (filterLower.startsWith('select-object') || filterLower.startsWith('select ') || filterLower === 'select') {
    return { output: selectObject(objects, args) };
  }

  // Sort-Object
  if (filterLower.startsWith('sort-object') || filterLower.startsWith('sort ') || filterLower === 'sort') {
    return { output: sortObject(objects, args) };
  }

  // Measure-Object
  if (filterLower.startsWith('measure-object') || filterLower.startsWith('measure ') || filterLower === 'measure') {
    return { output: [], formatted: measureObject(objects, args) };
  }

  // Select-String
  if (filterLower.startsWith('select-string') || filterLower.startsWith('sls ') || filterLower === 'sls') {
    return { output: selectString(objects, args) };
  }

  // Format-Table
  if (filterLower.startsWith('format-table') || filterLower.startsWith('ft ') || filterLower === 'ft') {
    return { output: [], formatted: formatTable(objects, args) };
  }

  // Format-List
  if (filterLower.startsWith('format-list') || filterLower.startsWith('fl ') || filterLower === 'fl') {
    return { output: [], formatted: formatList(objects, args) };
  }

  // Out-String (convert to string)
  if (filterLower.startsWith('out-string')) {
    return { output: [], formatted: formatDefault(objects) };
  }

  // Unknown filter — pass through as string
  return { output: objects };
}

/**
 * Run a full pipeline: first command output + array of filter stages.
 * Returns the final formatted string.
 */
export function runPipeline(firstOutput: PipelineInput, filters: string[]): string {
  let current: PipelineInput = firstOutput;

  for (const filter of filters) {
    const result = applyPipelineStage(current, filter);
    if (result.formatted !== undefined) {
      // A formatter was applied — return its output
      // (subsequent filters would process the formatted string)
      current = result.formatted;
      continue;
    }
    current = result.output;
  }

  // Final output
  if (typeof current === 'string') return current;
  if (Array.isArray(current) && current.length > 0) return formatDefault(current);
  return '';
}

// ─── Helpers ─────────────────────────────────────────────────────

function extractFilterArgs(filter: string): string {
  // Remove the cmdlet name, return the rest
  const parts = filter.trim().split(/\s+/);
  // Handle aliases like ? { ... }
  if (parts[0] === '?') return parts.slice(1).join(' ');
  return parts.slice(1).join(' ');
}

/**
 * Tokenize arguments respecting quotes and braces.
 */
function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let braceDepth = 0;

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }

    if (ch === '{') {
      braceDepth++;
      current += ch;
      continue;
    }
    if (ch === '}') {
      braceDepth--;
      current += ch;
      continue;
    }

    if (braceDepth > 0) {
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }
  if (current) tokens.push(current);

  // Clean quotes from tokens
  return tokens.map(t => t.replace(/^['"]|['"]$/g, ''));
}

// ─── Structured cmdlet output builders ───────────────────────────
// These return PSObject[] for use in pipelines.

export function buildProcessObjects(): PSObject[] {
  return [
    { Handles: 52,   'NPM(K)': 5,  'PM(K)': 2036,   'WS(K)': 3556,   'CPU(s)': 0.02,  Id: 5120, SI: 1, ProcessName: 'cmd' },
    { Handles: 186,  'NPM(K)': 12, 'PM(K)': 7032,   'WS(K)': 13568,  'CPU(s)': 0.08,  Id: 5132, SI: 1, ProcessName: 'conhost' },
    { Handles: 596,  'NPM(K)': 18, 'PM(K)': 3256,   'WS(K)': 6144,   'CPU(s)': 3.45,  Id: 472,  SI: 0, ProcessName: 'csrss' },
    { Handles: 1258, 'NPM(K)': 35, 'PM(K)': 78320,  'WS(K)': 98816,  'CPU(s)': 24.56, Id: 1024, SI: 1, ProcessName: 'dwm' },
    { Handles: 2456, 'NPM(K)': 89, 'PM(K)': 112640, 'WS(K)': 165888, 'CPU(s)': 45.23, Id: 2848, SI: 1, ProcessName: 'explorer' },
    { Handles: 856,  'NPM(K)': 23, 'PM(K)': 12288,  'WS(K)': 15360,  'CPU(s)': 1.23,  Id: 636,  SI: 0, ProcessName: 'lsass' },
    { Handles: 416,  'NPM(K)': 14, 'PM(K)': 6144,   'WS(K)': 9216,   'CPU(s)': 0.98,  Id: 620,  SI: 0, ProcessName: 'services' },
    { Handles: 53,   'NPM(K)': 3,  'PM(K)': 512,    'WS(K)': 1280,   'CPU(s)': 0.05,  Id: 340,  SI: 0, ProcessName: 'smss' },
    { Handles: 648,  'NPM(K)': 22, 'PM(K)': 18432,  'WS(K)': 24576,  'CPU(s)': 2.34,  Id: 784,  SI: 0, ProcessName: 'svchost' },
    { Handles: 423,  'NPM(K)': 15, 'PM(K)': 10240,  'WS(K)': 14336,  'CPU(s)': 1.56,  Id: 836,  SI: 0, ProcessName: 'svchost' },
    { Handles: 188,  'NPM(K)': 0,  'PM(K)': 144,    'WS(K)': 1024,   'CPU(s)': 0.00,  Id: 4,    SI: 0, ProcessName: 'System' },
    { Handles: 108,  'NPM(K)': 5,  'PM(K)': 2560,   'WS(K)': 4608,   'CPU(s)': 0.12,  Id: 548,  SI: 0, ProcessName: 'wininit' },
  ];
}

export function buildServiceObjects(): PSObject[] {
  return [
    { Status: 'Running', Name: 'Dhcp',              DisplayName: 'DHCP Client' },
    { Status: 'Running', Name: 'Dnscache',           DisplayName: 'DNS Client' },
    { Status: 'Running', Name: 'EventLog',           DisplayName: 'Windows Event Log' },
    { Status: 'Running', Name: 'LanmanServer',       DisplayName: 'Server' },
    { Status: 'Running', Name: 'LanmanWorkstation',  DisplayName: 'Workstation' },
    { Status: 'Running', Name: 'mpssvc',             DisplayName: 'Windows Defender Firewall' },
    { Status: 'Running', Name: 'RpcSs',              DisplayName: 'Remote Procedure Call (RPC)' },
    { Status: 'Running', Name: 'Spooler',            DisplayName: 'Print Spooler' },
    { Status: 'Running', Name: 'W32Time',            DisplayName: 'Windows Time' },
    { Status: 'Running', Name: 'WinRM',              DisplayName: 'Windows Remote Management (WS-Management)' },
  ];
}

export function buildCommandObjects(): PSObject[] {
  return [
    { CommandType: 'Cmdlet', Name: 'Clear-Host',             Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Core' },
    { CommandType: 'Cmdlet', Name: 'Copy-Item',              Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Get-ChildItem',          Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Get-Command',            Version: '3.0.0.0', Source: 'Microsoft.PowerShell.Core' },
    { CommandType: 'Cmdlet', Name: 'Get-Content',            Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Get-Help',               Version: '3.0.0.0', Source: 'Microsoft.PowerShell.Core' },
    { CommandType: 'Cmdlet', Name: 'Get-Location',           Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Get-NetAdapter',         Version: '2.0.0.0', Source: 'NetAdapter' },
    { CommandType: 'Cmdlet', Name: 'Get-NetIPAddress',       Version: '1.0.0.0', Source: 'NetTCPIP' },
    { CommandType: 'Cmdlet', Name: 'Get-NetIPConfiguration', Version: '1.0.0.0', Source: 'NetTCPIP' },
    { CommandType: 'Cmdlet', Name: 'Get-Process',            Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Move-Item',              Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'New-Item',               Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Remove-Item',            Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Rename-Item',            Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Set-Content',            Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Set-Location',           Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Test-Connection',        Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Management' },
    { CommandType: 'Cmdlet', Name: 'Write-Host',             Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Utility' },
    { CommandType: 'Cmdlet', Name: 'Write-Output',           Version: '3.1.0.0', Source: 'Microsoft.PowerShell.Utility' },
  ];
}
