const KEYWORD_SHAPE = /^[a-z][a-z0-9-]{1,29}$/;

const NON_KEYWORD_LITERALS: ReadonlySet<string> = new Set([
  'string', 'number', 'boolean', 'object', 'function', 'undefined',
  'symbol', 'bigint', 'true', 'false', 'null',
]);

function firstParamName(source: string): string | null {
  const arrow = /^\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(
    source.replace(/^function[^(]*\(/, '('),
  );
  const name = arrow?.[1] ?? null;
  if (name === null || name === 'function') return null;
  return name;
}

function argAliases(source: string, param: string): ReadonlySet<string> {
  const aliases = new Set<string>([param]);
  const paramRef = new RegExp(`\\b${param}\\b`);
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^;\n]*)/g;
  for (let m = declRe.exec(source); m !== null; m = declRe.exec(source)) {
    const name = m[1];
    const rhs = m[2] ?? '';
    if (name !== undefined && paramRef.test(rhs)) aliases.add(name);
  }
  return aliases;
}

function rootIdentifier(expression: string): string | null {
  const m = /^\s*!?\(?\s*([A-Za-z_$][\w$]*)/.exec(expression);
  return m?.[1] ?? null;
}

/**
 * Root identifier of the member/call expression ENDING at the given
 * position: for "…if(t" → t, "…const x = args[0]?.toLowerCase()" → args,
 * "…state.mode" → state. Anchored from the end so surrounding syntax
 * (if(, &&, return …) never leaks into the root.
 */
function trailingExpressionRoot(windowBeforeOperator: string): string | null {
  const m = /([A-Za-z_$][\w$]*)(?:(?:\[[^\]]*\])|(?:\?\.[A-Za-z_$][\w$]*)|(?:\.[A-Za-z_$][\w$]*)|(?:\(\))|(?:\?\.))*\s*$/.exec(windowBeforeOperator);
  return m?.[1] ?? null;
}

/**
 * Extract the fixed CLI keywords a greedy command handler dispatches on,
 * by scanning the handler's own source for literal comparisons against
 * its args parameter (or direct aliases of it):
 *
 *   args[0] === 'summary'          → summary
 *   last !== 'status'              → status
 *   'switchport'.startsWith(last)  → switchport
 *   switch (verb) { case 'add': }  → add
 *
 * Literals compared against anything else (device state, typeof, output
 * strings) are ignored, as are literals that don't look like CLI
 * keywords (uppercase, spaces, one character).
 */
export function extractHandlerKeywords(handlerSource: string): readonly string[] {
  const param = firstParamName(handlerSource);
  if (param === null) return [];
  const aliases = argAliases(handlerSource, param);
  const found = new Set<string>();

  const accept = (literal: string | undefined): void => {
    if (literal === undefined) return;
    if (!KEYWORD_SHAPE.test(literal)) return;
    if (NON_KEYWORD_LITERALS.has(literal)) return;
    found.add(literal);
  };

  const cmpRe = /[!=]==?\s*['"]([^'"\n]+)['"]/g;
  for (let m = cmpRe.exec(handlerSource); m !== null; m = cmpRe.exec(handlerSource)) {
    const window = handlerSource.slice(Math.max(0, m.index - 80), m.index);
    const lhsRoot = trailingExpressionRoot(window);
    if (lhsRoot !== null && aliases.has(lhsRoot)) accept(m[1]);
  }

  const revCmpRe = /['"]([^'"\n]+)['"]\s*[!=]==?\s*([A-Za-z_$][\w$]*)/g;
  for (let m = revCmpRe.exec(handlerSource); m !== null; m = revCmpRe.exec(handlerSource)) {
    const rhs = m[2];
    if (rhs !== undefined && aliases.has(rhs)) accept(m[1]);
  }

  const startsRe = /['"]([^'"\n]+)['"]\s*\.startsWith\(\s*([A-Za-z_$][\w$]*)/g;
  for (let m = startsRe.exec(handlerSource); m !== null; m = startsRe.exec(handlerSource)) {
    const arg = m[2];
    if (arg !== undefined && aliases.has(arg)) accept(m[1]);
  }

  const methodRe = /\.(?:includes|startsWith|indexOf)\(\s*['"]([^'"\n]+)['"]/g;
  for (let m = methodRe.exec(handlerSource); m !== null; m = methodRe.exec(handlerSource)) {
    const window = handlerSource.slice(Math.max(0, m.index - 80), m.index);
    const root = trailingExpressionRoot(window);
    if (root !== null && aliases.has(root)) accept(m[1]);
  }

  const switchRe = /switch\s*\(([^)]*)\)\s*\{([^}]*)\}/g;
  for (let m = switchRe.exec(handlerSource); m !== null; m = switchRe.exec(handlerSource)) {
    const discriminantRoot = rootIdentifier(m[1] ?? '');
    if (discriminantRoot === null || !aliases.has(discriminantRoot)) continue;
    const body = m[2] ?? '';
    const caseRe = /case\s*['"]([^'"\n]+)['"]/g;
    for (let c = caseRe.exec(body); c !== null; c = caseRe.exec(body)) {
      accept(c[1]);
    }
  }

  return [...found].sort();
}
