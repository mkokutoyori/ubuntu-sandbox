#!/usr/bin/env node
/**
 * audit-mvc.mjs — Standardization audit for the Ubuntu Sandbox MVC / reactive
 * event-driven architecture. Zero dependencies, pure Node ESM.
 *
 * Measures the three "standardization fractures" the project is converging away
 * from (see docs/REFONTE-REACTIVE-EVENT-DRIVEN.md, objectives O5/O3/O2):
 *
 *   CHECK 1 (O5)  View ↔ Model coupling  — components importing the mutable domain.
 *   CHECK 2 (O3)  Timer discipline        — native setTimeout/setInterval outside Scheduler.
 *   CHECK 3 (O2)  Un-projected models      — *Engine without a co-located observables.ts.
 *
 * Usage (run from the project root):
 *   node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs
 *   node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs --json
 *   node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs --strict   # exit 1 if any violation
 *   node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs --root /path/to/repo
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';

// ── CLI args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const rootFlagIdx = argv.indexOf('--root');
const ROOT = rootFlagIdx !== -1 && argv[rootFlagIdx + 1] ? argv[rootFlagIdx + 1] : process.cwd();
const SRC = join(ROOT, 'src');

if (!existsSync(SRC)) {
  console.error(`✖ Could not find a "src/" directory under: ${ROOT}\n  Run from the project root, or pass --root <path>.`);
  process.exit(2);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const CODE_EXT = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '__tests__']);

/** Recursively list code files under `dir`, skipping noise dirs and tests. */
function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...listFiles(full));
    } else if (CODE_EXT.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n');
}

const rel = (f) => relative(ROOT, f);

// ── CHECK 1 — View ↔ Model coupling (O5) ─────────────────────────────────────
function checkViewModelCoupling() {
  const componentsDir = join(SRC, 'components');
  const findings = [];
  if (!existsSync(componentsDir)) return findings;

  const importDomain = /\bfrom\s+['"]@\/network(\/[^'"]*)?['"]/;
  for (const file of listFiles(componentsDir)) {
    const lines = readLines(file);
    lines.forEach((line, i) => {
      if (!importDomain.test(line)) return;
      const isTypeOnly = /^\s*import\s+type\b/.test(line);
      // Escalate when a concrete mutable class is pulled in.
      const mutable = /\b(Equipment|createDevice|DeviceFactory)\b/.test(line) || /\b\w*Engine\b/.test(line);
      const severity = mutable && !isTypeOnly ? 'ERROR' : isTypeOnly ? 'INFO' : 'WARN';
      findings.push({ file: rel(file), line: i + 1, code: line.trim(), severity });
    });
  }
  return findings;
}

// ── CHECK 2 — Timer discipline (O3) ──────────────────────────────────────────
function checkTimerDiscipline() {
  const findings = [];
  // Native call NOT preceded by `.` or a word char (so `scheduler.setTimeout` is allowed).
  const nativeTimer = /(?<![.\w])(setTimeout|setInterval)\s*\(/g;
  for (const file of listFiles(SRC)) {
    if (/events[/\\]Scheduler\.ts$/.test(file)) continue; // the one legitimate home
    const lines = readLines(file);
    lines.forEach((line, i) => {
      // Ignore commented lines (cheap heuristic).
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      let m;
      nativeTimer.lastIndex = 0;
      while ((m = nativeTimer.exec(line)) !== null) {
        findings.push({ file: rel(file), line: i + 1, fn: m[1], code: trimmed, severity: 'WARN' });
      }
    });
  }
  return findings;
}

// ── CHECK 3 — Un-projected models (O2/O5) ────────────────────────────────────
function checkUnprojectedModels() {
  const networkDir = join(SRC, 'network');
  const findings = [];
  if (!existsSync(networkDir)) return findings;

  const declaresEngine = /\bclass\s+\w*Engine\b/;
  for (const file of listFiles(networkDir)) {
    const base = basename(file);
    const isEngineFile = /Engine\.ts$/.test(base);
    if (!isEngineFile) {
      // also catch files that declare an *Engine class under another name
      const src = readFileSync(file, 'utf8');
      if (!declaresEngine.test(src)) continue;
    }
    // Adapters wrap an engine but are not the model themselves.
    if (/Adapter\.ts$/.test(base)) continue;
    const dir = dirname(file);
    if (!existsSync(join(dir, 'observables.ts'))) {
      findings.push({ file: rel(file), dir: rel(dir), severity: 'WARN' });
    }
  }
  return findings;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const coupling = checkViewModelCoupling();
const timers = checkTimerDiscipline();
const unprojected = checkUnprojectedModels();

const couplingErrors = coupling.filter((f) => f.severity === 'ERROR');
const couplingWarns = coupling.filter((f) => f.severity === 'WARN');
const couplingInfos = coupling.filter((f) => f.severity === 'INFO');

const totalViolations = couplingErrors.length + couplingWarns.length + timers.length + unprojected.length;

if (asJson) {
  console.log(JSON.stringify(
    {
      root: ROOT,
      checks: {
        viewModelCoupling: coupling,
        timerDiscipline: timers,
        unprojectedModels: unprojected,
      },
      totals: {
        couplingErrors: couplingErrors.length,
        couplingWarnings: couplingWarns.length,
        couplingInfo: couplingInfos.length,
        nativeTimers: timers.length,
        unprojectedEngines: unprojected.length,
        violations: totalViolations,
      },
    },
    null,
    2,
  ));
  process.exit(strict && totalViolations > 0 ? 1 : 0);
}

// ── Human-readable report ──────────────────────────────────────────────────
const SAMPLE = 15;
function section(title) {
  console.log(`\n${'─'.repeat(78)}\n  ${title}\n${'─'.repeat(78)}`);
}
function sample(items, fmt) {
  items.slice(0, SAMPLE).forEach((it) => console.log('   ' + fmt(it)));
  if (items.length > SAMPLE) console.log(`   … +${items.length - SAMPLE} more`);
}

console.log(`\n  MVC standardization audit  —  ${SRC}`);

section('CHECK 1 · View ↔ Model coupling (O5)  — components must read VMs, not the domain');
if (coupling.length === 0) {
  console.log('   ✓ No component imports from @/network.');
} else {
  console.log(`   ✖ ${couplingErrors.length} error(s) · ⚠ ${couplingWarns.length} warning(s) · ℹ ${couplingInfos.length} type-only`);
  sample([...couplingErrors, ...couplingWarns], (f) => `[${f.severity}] ${f.file}:${f.line}  ${f.code}`);
}

section('CHECK 2 · Timer discipline (O3)  — all timers must go through the Scheduler');
if (timers.length === 0) {
  console.log('   ✓ No native setTimeout/setInterval outside the Scheduler.');
} else {
  console.log(`   ⚠ ${timers.length} native timer call(s) found`);
  sample(timers, (f) => `${f.file}:${f.line}  ${f.fn}(…)`);
}

section('CHECK 3 · Un-projected models (O2/O5)  — every *Engine needs an observables.ts');
if (unprojected.length === 0) {
  console.log('   ✓ Every engine has a co-located observables.ts.');
} else {
  console.log(`   ⚠ ${unprojected.length} engine(s) without observables.ts`);
  sample(unprojected, (f) => `${f.file}   (add ${f.dir}/observables.ts)`);
}

// ── Score ────────────────────────────────────────────────────────────────────
section('SUMMARY');
console.log(`   View↔Model coupling : ${couplingErrors.length} errors, ${couplingWarns.length} warnings (${couplingInfos.length} type-only)`);
console.log(`   Native timers       : ${timers.length}`);
console.log(`   Un-projected engines: ${unprojected.length}`);
console.log(`   ─────────────────────────────────────────`);
console.log(`   Total violations    : ${totalViolations}`);

let grade;
if (totalViolations === 0) grade = 'A — fully standardized 🎯';
else if (totalViolations <= 20) grade = 'B — mostly standardized';
else if (totalViolations <= 60) grade = 'C — migration in progress';
else grade = 'D — significant ad-hoc surface remains';
console.log(`   Grade               : ${grade}`);
console.log('');
console.log('   Tip: run before and after your change — the total must never go up.');
console.log('');

process.exit(strict && totalViolations > 0 ? 1 : 0);
