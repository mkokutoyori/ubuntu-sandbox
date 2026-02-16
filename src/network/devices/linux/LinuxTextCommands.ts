/**
 * Text processing commands: grep, head, tail, wc, sort, cut, uniq, tr, awk
 */

import { VirtualFileSystem } from './VirtualFileSystem';
import { ShellContext, expandGlob } from './LinuxFileCommands';

export function cmdGrep(ctx: ShellContext, args: string[], stdin?: string): string {
  let caseInsensitive = false;
  let countOnly = false;
  let recursive = false;
  let extendedRegex = false;
  let invertMatch = false;
  const patterns: string[] = [];
  const files: string[] = [];

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-i') { caseInsensitive = true; i++; continue; }
    if (a === '-c') { countOnly = true; i++; continue; }
    if (a === '-r') { recursive = true; i++; continue; }
    if (a === '-E') { extendedRegex = true; i++; continue; }
    if (a === '-v') { invertMatch = true; i++; continue; }
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      // Combined flags like -ic
      for (const f of a.slice(1)) {
        if (f === 'i') caseInsensitive = true;
        if (f === 'c') countOnly = true;
        if (f === 'r') recursive = true;
        if (f === 'E') extendedRegex = true;
        if (f === 'v') invertMatch = true;
      }
      i++;
      continue;
    }
    if (patterns.length === 0) {
      patterns.push(a);
    } else {
      // Expand globs for files
      const expanded = expandGlob(ctx, a);
      files.push(...expanded);
    }
    i++;
  }

  if (patterns.length === 0) return '';

  const pattern = patterns[0];
  const flags = caseInsensitive ? 'i' : '';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  const results: string[] = [];
  const multiFile = files.length > 1 || recursive;

  if (files.length === 0 && stdin !== undefined) {
    // Filter stdin
    const lines = stdin.split('\n');
    for (const line of lines) {
      const match = regex.test(line);
      if (match !== invertMatch) {
        results.push(line);
      }
    }
    if (countOnly) return results.length.toString();
    return results.join('\n');
  }

  const fileList: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    if (recursive && ctx.vfs.getType(absPath) === 'directory') {
      collectFiles(ctx, absPath, f, fileList);
    } else {
      fileList.push(f);
    }
  }

  const multiOut = fileList.length > 1;

  for (const f of fileList) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content === null) continue;

    const lines = content.split('\n');
    let count = 0;
    for (const line of lines) {
      if (!line && lines.indexOf(line) === lines.length - 1 && content.endsWith('\n')) continue;
      const match = regex.test(line);
      if (match !== invertMatch) {
        count++;
        if (!countOnly) {
          results.push(multiOut ? `${f}:${line}` : line);
        }
      }
    }
    if (countOnly) {
      results.push(multiOut ? `${f}:${count}` : count.toString());
    }
  }

  return results.join('\n');
}

function collectFiles(ctx: ShellContext, absDir: string, displayDir: string, out: string[]): void {
  const entries = ctx.vfs.listDirectory(absDir);
  if (!entries) return;
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const childAbs = absDir + '/' + e.name;
    const childDisplay = displayDir + '/' + e.name;
    if (e.inode.type === 'directory') {
      collectFiles(ctx, childAbs, childDisplay, out);
    } else if (e.inode.type === 'file') {
      out.push(childDisplay);
    }
  }
}

export function cmdHead(ctx: ShellContext, args: string[], stdin?: string): string {
  let lines = 10;
  let bytes: number | undefined;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' && args[i + 1]) { lines = parseInt(args[i + 1], 10); i++; continue; }
    if (a === '-c' && args[i + 1]) { bytes = parseInt(args[i + 1], 10); i++; continue; }
    if (a.match(/^-\d+$/)) { lines = parseInt(a.slice(1), 10); continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  const processContent = (content: string): string => {
    if (bytes !== undefined) {
      return content.slice(0, bytes);
    }
    return content.split('\n').slice(0, lines).join('\n');
  };

  if (files.length === 0) {
    return stdin !== undefined ? processContent(stdin) : '';
  }

  const results: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    if (bytes !== undefined) {
      const data = ctx.vfs.readFileBytes(absPath, bytes);
      results.push(data);
    } else {
      const content = ctx.vfs.readFile(absPath);
      if (content !== null) results.push(processContent(content));
    }
  }
  return results.join('\n');
}

export function cmdTail(ctx: ShellContext, args: string[], stdin?: string): string {
  let lines = 10;
  let follow = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' && args[i + 1]) { lines = parseInt(args[i + 1], 10); i++; continue; }
    if (a === '-f') { follow = true; continue; }
    if (a.match(/^-\d+$/)) { lines = parseInt(a.slice(1), 10); continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  const processContent = (content: string): string => {
    const allLines = content.split('\n');
    // Remove trailing empty line if content ends with \n
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
    return allLines.slice(-lines).join('\n');
  };

  if (files.length === 0) {
    return stdin !== undefined ? processContent(stdin) : '';
  }

  const results: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content !== null) results.push(processContent(content));
  }
  // tail -f just returns content for our simulator
  return results.join('\n');
}

export function cmdWc(ctx: ShellContext, args: string[], stdin?: string): string {
  let countBytes = false;
  let countLines = false;
  let countWords = false;
  const files: string[] = [];

  for (const a of args) {
    if (a === '-c') { countBytes = true; continue; }
    if (a === '-l') { countLines = true; continue; }
    if (a === '-w') { countWords = true; continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  // Default: show all three
  if (!countBytes && !countLines && !countWords) {
    countBytes = true; countLines = true; countWords = true;
  }

  const processContent = (content: string, filename?: string): string => {
    const parts: string[] = [];
    if (countLines) parts.push(content.split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[arr.length - 1] !== '').length.toString());
    if (countWords) parts.push(content.split(/\s+/).filter(Boolean).length.toString());
    if (countBytes) parts.push(content.length.toString());
    if (filename) parts.push(filename);
    return parts.join(' ');
  };

  if (files.length === 0) {
    return stdin !== undefined ? processContent(stdin) : '';
  }

  const results: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content !== null) results.push(processContent(content, f));
  }
  return results.join('\n');
}

export function cmdSort(ctx: ShellContext, args: string[], stdin?: string): string {
  let numeric = false;
  let reverse = false;
  const files: string[] = [];

  for (const a of args) {
    if (a === '-n') { numeric = true; continue; }
    if (a === '-r') { reverse = true; continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    content = stdin ?? '';
  }

  let lines = content.split('\n').filter(l => l.length > 0);

  if (numeric) {
    lines.sort((a, b) => parseFloat(a) - parseFloat(b));
  } else {
    lines.sort();
  }

  if (reverse) lines.reverse();
  return lines.join('\n');
}

export function cmdCut(ctx: ShellContext, args: string[], stdin?: string): string {
  let delimiter = '\t';
  let fields: number[] = [];
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-d')) {
      delimiter = a.length > 2 ? a.slice(2) : args[++i] || '\t';
      continue;
    }
    if (a.startsWith('-f')) {
      const fStr = a.length > 2 ? a.slice(2) : args[++i] || '';
      fields = fStr.split(',').map(f => parseInt(f, 10));
      continue;
    }
    if (!a.startsWith('-')) files.push(a);
  }

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    content = stdin ?? '';
  }

  const lines = content.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(delimiter);
    const selected = fields.map(f => parts[f - 1] || '').join(delimiter);
    result.push(selected);
  }
  return result.join('\n');
}

export function cmdUniq(ctx: ShellContext, args: string[], stdin?: string): string {
  const files: string[] = [];
  for (const a of args) {
    if (!a.startsWith('-')) files.push(a);
  }

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    content = stdin ?? '';
  }

  const lines = content.split('\n');
  const result: string[] = [];
  let prevLine: string | null = null;
  for (const line of lines) {
    if (line !== prevLine) {
      result.push(line);
      prevLine = line;
    }
  }
  // Remove trailing empty line
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  return result.join('\n');
}

export function cmdTr(ctx: ShellContext, args: string[], stdin?: string): string {
  if (args.length < 2 || !stdin) return stdin ?? '';

  const set1 = expandCharSet(args[0]);
  const set2 = expandCharSet(args[1]);

  let result = '';
  for (const c of stdin) {
    const idx = set1.indexOf(c);
    if (idx !== -1 && idx < set2.length) {
      result += set2[idx];
    } else {
      result += c;
    }
  }
  return result;
}

function expandCharSet(s: string): string {
  // Handle ranges like a-z, A-Z, 0-9
  let result = '';
  for (let i = 0; i < s.length; i++) {
    if (i + 2 < s.length && s[i + 1] === '-') {
      const start = s.charCodeAt(i);
      const end = s.charCodeAt(i + 2);
      for (let c = start; c <= end; c++) {
        result += String.fromCharCode(c);
      }
      i += 2;
    } else {
      result += s[i];
    }
  }
  return result;
}

export function cmdAwk(ctx: ShellContext, args: string[], stdin?: string): string {
  let fieldSep = ' ';
  let program = '';
  const files: string[] = [];
  const vars: Map<string, string> = new Map();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-F')) {
      fieldSep = a.length > 2 ? a.slice(2) : args[++i] || ' ';
      // Remove quotes from field separator
      fieldSep = fieldSep.replace(/^["']|["']$/g, '');
      continue;
    }
    if (a === '-v' && args[i + 1]) {
      const [key, val] = args[++i].split('=');
      vars.set(key, val);
      continue;
    }
    if (!program) {
      program = a;
    } else {
      files.push(a);
    }
  }

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    content = stdin ?? '';
  }

  return executeAwk(content, program, fieldSep, vars);
}

function executeAwk(content: string, program: string, fs: string, vars: Map<string, string>): string {
  // Simple awk interpreter
  const lines = content.split('\n').filter(l => l.length > 0);
  const results: string[] = [];

  // Parse program into blocks: condition { action }
  // Support: BEGIN { ... }, END { ... }, condition { ... }, { ... }
  const blocks = parseAwkBlocks(program);

  // Track awk variables
  const awkVars: Map<string, number | string> = new Map();
  for (const [k, v] of vars) awkVars.set(k, v);

  // Execute BEGIN block
  for (const block of blocks) {
    if (block.condition === 'BEGIN') {
      const out = executeAwkAction(block.action, [], fs, awkVars, '');
      if (out) results.push(out);
    }
  }

  // Process each line
  for (const line of lines) {
    const fields = fs === ' '
      ? line.split(/\s+/).filter(Boolean)
      : line.split(fs);

    for (const block of blocks) {
      if (block.condition === 'BEGIN' || block.condition === 'END') continue;

      if (!block.condition || evaluateAwkCondition(block.condition, fields, fs, awkVars)) {
        const out = executeAwkAction(block.action, fields, fs, awkVars, line);
        if (out) results.push(out);
      }
    }
  }

  // Execute END block
  for (const block of blocks) {
    if (block.condition === 'END') {
      const out = executeAwkAction(block.action, [], fs, awkVars, '');
      if (out) results.push(out);
    }
  }

  return results.join('\n');
}

interface AwkBlock {
  condition: string;
  action: string;
}

function parseAwkBlocks(program: string): AwkBlock[] {
  const blocks: AwkBlock[] = [];
  let i = 0;
  const p = program.trim();

  while (i < p.length) {
    // Skip whitespace
    while (i < p.length && /\s/.test(p[i])) i++;
    if (i >= p.length) break;

    let condition = '';
    let action = '';

    // Check if starts with { (no condition)
    if (p[i] === '{') {
      condition = '';
      const end = findMatchingBrace(p, i);
      action = p.slice(i + 1, end).trim();
      i = end + 1;
    } else {
      // Read condition until {
      const braceIdx = p.indexOf('{', i);
      if (braceIdx === -1) {
        // No braces: treat remaining as condition with default print action
        condition = p.slice(i).trim();
        action = 'print';
        i = p.length;
      } else {
        condition = p.slice(i, braceIdx).trim();
        const end = findMatchingBrace(p, braceIdx);
        action = p.slice(braceIdx + 1, end).trim();
        i = end + 1;
      }
    }

    blocks.push({ condition, action });
  }

  return blocks;
}

function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return s.length;
}

function evaluateAwkCondition(condition: string, fields: string[], fs: string, vars: Map<string, number | string>): boolean {
  // Handle: $2 > 30, $1 == "foo", etc
  const match = condition.match(/\$(\d+)\s*(>|<|>=|<=|==|!=)\s*(.+)/);
  if (match) {
    const fieldIdx = parseInt(match[1], 10);
    const op = match[2];
    const valueStr = match[3].replace(/^["']|["']$/g, '');
    const fieldVal = fieldIdx === 0 ? fields.join(fs) : (fields[fieldIdx - 1] || '');
    const numField = parseFloat(fieldVal);
    const numVal = parseFloat(valueStr);

    if (!isNaN(numField) && !isNaN(numVal)) {
      switch (op) {
        case '>': return numField > numVal;
        case '<': return numField < numVal;
        case '>=': return numField >= numVal;
        case '<=': return numField <= numVal;
        case '==': return numField === numVal;
        case '!=': return numField !== numVal;
      }
    }
    switch (op) {
      case '==': return fieldVal === valueStr;
      case '!=': return fieldVal !== valueStr;
    }
  }
  return true;
}

function executeAwkAction(action: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  const statements = action.split(';').map(s => s.trim()).filter(Boolean);
  const outputs: string[] = [];

  for (const stmt of statements) {
    // Variable assignment: sum += $2, count = count + 1
    const assignMatch = stmt.match(/^(\w+)\s*(\+?=)\s*(.+)$/);
    if (assignMatch && !stmt.startsWith('print')) {
      const varName = assignMatch[1];
      const op = assignMatch[2];
      const expr = resolveAwkExpr(assignMatch[3], fields, fs, vars, line);
      const numExpr = parseFloat(expr);
      if (op === '+=') {
        const current = parseFloat(String(vars.get(varName) || '0'));
        vars.set(varName, current + (isNaN(numExpr) ? 0 : numExpr));
      } else {
        vars.set(varName, isNaN(numExpr) ? expr : numExpr);
      }
      continue;
    }

    // Print statement
    if (stmt.startsWith('print')) {
      const printArgs = stmt.slice(5).trim();
      if (!printArgs) {
        outputs.push(line);
        continue;
      }
      outputs.push(resolveAwkPrint(printArgs, fields, fs, vars, line));
    }
  }

  return outputs.join('\n');
}

function resolveAwkExpr(expr: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  // Replace $N with field values
  let result = expr.replace(/\$(\d+)/g, (_, n) => {
    const idx = parseInt(n, 10);
    return idx === 0 ? line : (fields[idx - 1] || '');
  });

  // Replace variable references
  for (const [k, v] of vars) {
    result = result.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v));
  }

  // Try to evaluate simple arithmetic
  try {
    const num = Function(`return (${result})`)();
    if (typeof num === 'number' && !isNaN(num)) return String(num);
  } catch { /* ignore */ }

  return result;
}

function resolveAwkPrint(printArgs: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  // Parse print arguments: "string" $1 var "string"
  const parts: string[] = [];
  let current = '';
  let inStr = false;
  let strChar = '"';

  for (let i = 0; i < printArgs.length; i++) {
    const c = printArgs[i];

    if (inStr) {
      if (c === strChar) {
        parts.push(current);
        current = '';
        inStr = false;
      } else {
        current += c;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      if (current.trim()) {
        parts.push(resolveAwkValue(current.trim(), fields, fs, vars, line));
        current = '';
      }
      inStr = true;
      strChar = c;
      continue;
    }

    if (c === ',') {
      if (current.trim()) {
        parts.push(resolveAwkValue(current.trim(), fields, fs, vars, line));
        current = '';
      }
      parts.push(' '); // comma = output field separator (space by default)
      continue;
    }

    current += c;
  }

  if (current.trim()) {
    parts.push(resolveAwkValue(current.trim(), fields, fs, vars, line));
  }

  return parts.join('');
}

function resolveAwkValue(val: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  // Handle $N
  if (val.startsWith('$')) {
    const idx = parseInt(val.slice(1), 10);
    if (!isNaN(idx)) {
      return idx === 0 ? line : (fields[idx - 1] || '');
    }
  }

  // Handle expressions like $2 + bonus
  if (val.includes('$') || val.includes('+') || val.includes('-')) {
    const resolved = resolveAwkExpr(val, fields, fs, vars, line);
    return resolved;
  }

  // Handle variable
  if (vars.has(val)) return String(vars.get(val));

  return val;
}
