/**
 * Simple bash script executor for simulated Linux environment.
 * Handles shebang, variables, $0/$1/$@/$#/$$/$?, if/for/while/case.
 */

import type { ShellContext } from './LinuxFileCommands';

export interface ScriptResult {
  output: string;
  exitCode: number;
}

/**
 * Execute a shell script from a file.
 */
export function executeScript(
  ctx: ShellContext,
  scriptPath: string,
  scriptArgs: string[],
  executeCommand: (cmd: string) => string,
): ScriptResult {
  const absPath = ctx.vfs.normalizePath(scriptPath, ctx.cwd);
  const content = ctx.vfs.readFile(absPath);
  if (content === null) {
    return { output: `bash: ${scriptPath}: No such file or directory`, exitCode: 127 };
  }

  return executeScriptContent(content, scriptPath, scriptArgs, executeCommand);
}

/**
 * Execute script content directly (for bash -c or piped content).
 */
export function executeScriptContent(
  content: string,
  scriptName: string,
  scriptArgs: string[],
  executeCommand: (cmd: string) => string,
): ScriptResult {
  const lines = content.split('\n');
  const outputs: string[] = [];
  let exitCode = 0;

  // Build variable table
  const vars: Map<string, string> = new Map();
  vars.set('0', scriptName);
  scriptArgs.forEach((a, i) => vars.set(String(i + 1), a));
  vars.set('@', scriptArgs.join(' '));
  vars.set('#', scriptArgs.length.toString());
  vars.set('$', String(Math.floor(Math.random() * 30000) + 1000));
  vars.set('?', '0');

  let i = 0;
  // Skip shebang
  if (lines.length > 0 && lines[0].startsWith('#!')) i = 1;

  while (i < lines.length) {
    const result = executeLine(lines, i, vars, outputs, executeCommand);
    i = result.nextLine;
    exitCode = result.exitCode;
    vars.set('?', String(exitCode));
  }

  return { output: outputs.join('\n'), exitCode };
}

interface LineResult {
  nextLine: number;
  exitCode: number;
}

function executeLine(
  lines: string[],
  lineIdx: number,
  vars: Map<string, string>,
  outputs: string[],
  executeCommand: (cmd: string) => string,
): LineResult {
  const rawLine = lines[lineIdx].trim();

  // Skip empty lines and comments
  if (!rawLine || rawLine.startsWith('#')) {
    return { nextLine: lineIdx + 1, exitCode: 0 };
  }

  // Variable assignment: VAR="value" or VAR=value
  const assignMatch = rawLine.match(/^(\w+)=(.*)$/);
  if (assignMatch && !rawLine.includes(' ')) {
    const val = resolveVars(assignMatch[2].replace(/^["']|["']$/g, ''), vars);
    vars.set(assignMatch[1], val);
    return { nextLine: lineIdx + 1, exitCode: 0 };
  }

  // Arithmetic: var=$((expr))
  const arithMatch = rawLine.match(/^(\w+)=\$\(\((.+)\)\)$/);
  if (arithMatch) {
    let expr = resolveVars(arithMatch[2], vars);
    // Also resolve bare variable names (without $) inside $((...))
    for (const [k, v] of vars) {
      if (/^\w+$/.test(k)) {
        expr = expr.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
      }
    }
    try {
      const val = Function(`return (${expr})`)();
      vars.set(arithMatch[1], String(val));
    } catch { /* ignore */ }
    return { nextLine: lineIdx + 1, exitCode: 0 };
  }

  // if-then-else-fi
  if (rawLine.startsWith('if ')) {
    return executeIf(lines, lineIdx, vars, outputs, executeCommand);
  }

  // for loop
  if (rawLine.startsWith('for ')) {
    return executeFor(lines, lineIdx, vars, outputs, executeCommand);
  }

  // while loop
  if (rawLine.startsWith('while ')) {
    return executeWhile(lines, lineIdx, vars, outputs, executeCommand);
  }

  // case statement
  if (rawLine.startsWith('case ')) {
    return executeCase(lines, lineIdx, vars, outputs, executeCommand);
  }

  // Regular command
  const expanded = resolveVars(rawLine, vars);
  const output = executeCommand(expanded);
  if (output) outputs.push(output);

  return { nextLine: lineIdx + 1, exitCode: output.includes('not found') ? 1 : 0 };
}

function executeIf(
  lines: string[],
  startIdx: number,
  vars: Map<string, string>,
  outputs: string[],
  executeCommand: (cmd: string) => string,
): LineResult {
  const conditionLine = lines[startIdx].trim();

  // Extract condition: if [ ... ]; then  or  if [ ... ]
  let condition = conditionLine.replace(/^if\s+/, '').replace(/;\s*then\s*$/, '').trim();
  let bodyStart = startIdx + 1;

  // Check if "then" is on the next line
  if (!conditionLine.includes('then')) {
    if (lines[bodyStart]?.trim() === 'then') bodyStart++;
  }

  // Evaluate condition
  const condResult = evaluateCondition(condition, vars, executeCommand);

  // Find fi, else
  let elseIdx = -1;
  let fiIdx = -1;
  let depth = 0;

  for (let i = bodyStart; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('if ')) depth++;
    if (l === 'fi') {
      if (depth === 0) { fiIdx = i; break; }
      depth--;
    }
    if (l === 'else' && depth === 0) elseIdx = i;
  }

  if (fiIdx === -1) return { nextLine: lines.length, exitCode: 1 };

  // Execute appropriate branch
  const branchStart = condResult ? bodyStart : (elseIdx !== -1 ? elseIdx + 1 : fiIdx);
  const branchEnd = condResult ? (elseIdx !== -1 ? elseIdx : fiIdx) : fiIdx;

  let exitCode = 0;
  for (let i = branchStart; i < branchEnd; i++) {
    const result = executeLine(lines, i, vars, outputs, executeCommand);
    i = result.nextLine - 1;
    exitCode = result.exitCode;
  }

  return { nextLine: fiIdx + 1, exitCode };
}

function executeFor(
  lines: string[],
  startIdx: number,
  vars: Map<string, string>,
  outputs: string[],
  executeCommand: (cmd: string) => string,
): LineResult {
  const forLine = lines[startIdx].trim();
  // for VAR in val1 val2 ...; do  or  for VAR in val1 val2 ...
  const match = forLine.match(/^for\s+(\w+)\s+in\s+(.+?)(?:;\s*do)?$/);
  if (!match) return { nextLine: startIdx + 1, exitCode: 1 };

  const varName = match[1];
  const valuesStr = resolveVars(match[2].trim(), vars);
  const values = valuesStr.split(/\s+/);

  let bodyStart = startIdx + 1;
  if (lines[bodyStart]?.trim() === 'do') bodyStart++;

  // Find done
  let doneIdx = -1;
  let depth = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('for ') || l.startsWith('while ')) depth++;
    if (l === 'done') {
      if (depth === 0) { doneIdx = i; break; }
      depth--;
    }
  }

  if (doneIdx === -1) return { nextLine: lines.length, exitCode: 1 };

  let exitCode = 0;
  for (const val of values) {
    vars.set(varName, val);
    for (let i = bodyStart; i < doneIdx; i++) {
      const result = executeLine(lines, i, vars, outputs, executeCommand);
      i = result.nextLine - 1;
      exitCode = result.exitCode;
    }
  }

  return { nextLine: doneIdx + 1, exitCode };
}

function executeWhile(
  lines: string[],
  startIdx: number,
  vars: Map<string, string>,
  outputs: string[],
  executeCommand: (cmd: string) => string,
): LineResult {
  const whileLine = lines[startIdx].trim();
  let condition = whileLine.replace(/^while\s+/, '').replace(/;\s*do\s*$/, '').trim();

  let bodyStart = startIdx + 1;
  if (lines[bodyStart]?.trim() === 'do') bodyStart++;

  // Find done
  let doneIdx = -1;
  let depth = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('for ') || l.startsWith('while ')) depth++;
    if (l === 'done') {
      if (depth === 0) { doneIdx = i; break; }
      depth--;
    }
  }

  if (doneIdx === -1) return { nextLine: lines.length, exitCode: 1 };

  let exitCode = 0;
  let maxIter = 100; // safety limit
  while (maxIter-- > 0) {
    const resolved = resolveVars(condition, vars);
    if (!evaluateCondition(resolved, vars, executeCommand)) break;

    for (let i = bodyStart; i < doneIdx; i++) {
      const result = executeLine(lines, i, vars, outputs, executeCommand);
      i = result.nextLine - 1;
      exitCode = result.exitCode;
    }
  }

  return { nextLine: doneIdx + 1, exitCode };
}

function executeCase(
  lines: string[],
  startIdx: number,
  vars: Map<string, string>,
  outputs: string[],
  executeCommand: (cmd: string) => string,
): LineResult {
  const caseLine = lines[startIdx].trim();
  // case $var in
  const match = caseLine.match(/^case\s+(.+)\s+in$/);
  if (!match) return { nextLine: startIdx + 1, exitCode: 1 };

  const value = resolveVars(match[1], vars);

  // Find esac, parse patterns
  let i = startIdx + 1;
  let exitCode = 0;
  let matched = false;

  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === 'esac') { i++; break; }

    // Pattern line: pattern) or *)
    const patternMatch = l.match(/^(.+?)\)\s*(.*)$/);
    if (patternMatch && !matched) {
      const pattern = patternMatch[1].trim();
      const isMatch = pattern === '*' || pattern === value;

      if (isMatch) {
        matched = true;
        // Execute inline action if present
        let action = patternMatch[2];
        if (action.endsWith(';;')) action = action.slice(0, -2).trim();

        if (action) {
          const expanded = resolveVars(action, vars);
          const output = executeCommand(expanded);
          if (output) outputs.push(output);
        }

        // Execute following lines until ;;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i].trim();
          if (bodyLine === ';;' || bodyLine.endsWith(';;')) {
            if (bodyLine.endsWith(';;') && bodyLine !== ';;') {
              const cmd = bodyLine.slice(0, -2).trim();
              if (cmd) {
                const expanded = resolveVars(cmd, vars);
                const output = executeCommand(expanded);
                if (output) outputs.push(output);
              }
            }
            i++;
            break;
          }
          if (bodyLine === 'esac') break;
          const result = executeLine(lines, i, vars, outputs, executeCommand);
          i = result.nextLine;
          exitCode = result.exitCode;
        }
        continue;
      }
    }
    i++;
  }

  return { nextLine: i, exitCode };
}

function evaluateCondition(condition: string, vars: Map<string, string>, executeCommand: (cmd: string) => string): boolean {
  // Handle [ ... ] and [[ ... ]]
  let inner = condition
    .replace(/^\[\[\s*/, '').replace(/\s*\]\]$/, '')
    .replace(/^\[\s*/, '').replace(/\s*\]$/, '')
    .trim();

  inner = resolveVars(inner, vars);

  // -f, -d, -e, -L file tests - use "test ... && echo T" pattern to get exit status
  const fileTestMatch = inner.match(/^(-[fdeL])\s+(.+)$/);
  if (fileTestMatch) {
    const file = fileTestMatch[2].replace(/^["']|["']$/g, '');
    const result = executeCommand(`test ${fileTestMatch[1]} ${file} && echo __TRUE__`);
    return result.includes('__TRUE__');
  }

  // Numeric comparison: $count -le 3
  const numCmpMatch = inner.match(/^(.+)\s+(-le|-lt|-ge|-gt|-eq|-ne)\s+(.+)$/);
  if (numCmpMatch) {
    const a = parseInt(numCmpMatch[1], 10);
    const b = parseInt(numCmpMatch[3], 10);
    switch (numCmpMatch[2]) {
      case '-le': return a <= b;
      case '-lt': return a < b;
      case '-ge': return a >= b;
      case '-gt': return a > b;
      case '-eq': return a === b;
      case '-ne': return a !== b;
    }
  }

  // String comparison
  const strCmpMatch = inner.match(/^"?(.+?)"?\s*(=|!=)\s*"?(.+?)"?$/);
  if (strCmpMatch) {
    return strCmpMatch[2] === '=' ? strCmpMatch[1] === strCmpMatch[3] : strCmpMatch[1] !== strCmpMatch[3];
  }

  return true;
}

function resolveVars(s: string, vars: Map<string, string>): string {
  // Replace $VAR, ${VAR}, $0..$9, $$, $?, $@, $#
  return s
    .replace(/\$\(\((.+?)\)\)/g, (_, expr) => {
      try {
        const resolved = resolveVars(expr, vars);
        return String(Function(`return (${resolved})`)());
      } catch { return '0'; }
    })
    .replace(/\$\((.+?)\)/g, (_, cmd) => {
      // Command substitution - simplified
      return cmd;
    })
    .replace(/\$\{(\w+)\}/g, (_, name) => vars.get(name) || '')
    .replace(/\$(\$)/g, () => vars.get('$') || '0')
    .replace(/\$\?/g, () => vars.get('?') || '0')
    .replace(/\$@/g, () => vars.get('@') || '')
    .replace(/\$#/g, () => vars.get('#') || '0')
    .replace(/\$(\d)/g, (_, n) => vars.get(n) || '')
    .replace(/\$(\w+)/g, (_, name) => vars.get(name) || '');
}
