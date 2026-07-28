/**
 * Every syslog message must render its values, not `?`.
 *
 * `LoggingConfig` reads each bus payload through an inline
 * `as unknown as { … }` cast, which switches type checking off: a field
 * name that does not exist compiles fine and renders `undefined`, which
 * the `?? '?'` fallbacks turn into `?`. That is how the reported
 * `%CDP-7-DEBUGGING: Neighbor ? on GigabitEthernet0/0` lost its
 * neighbour, and an audit found 57 subscriptions with the same defect —
 * more than half of them.
 *
 * The guard below re-derives, from the source, which fields each
 * subscription reads and which its topic actually publishes. It fails on
 * any new mismatch, so the cast cannot silently rot again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALL_TS = walk(ROOT);

/** topic -> the payload interface name it declares, or its inline fields. */
function collectTopics(): { named: Map<string, string>; inline: Map<string, Set<string>> } {
  const named = new Map<string, string>();
  const inline = new Map<string, Set<string>>();
  for (const file of ALL_TS) {
    if (!file.endsWith('events.ts') && !file.endsWith('events/types.ts')) continue;
    const txt = readFileSync(file, 'utf8');
    for (const m of txt.matchAll(/topic:\s*'([^']+)';\s*payload:\s*([A-Za-z0-9_]+)/g)) {
      if (!named.has(m[1])) named.set(m[1], m[2]);
    }
    for (const m of txt.matchAll(/topic:\s*'([^']+)';\s*payload:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
      if (inline.has(m[1])) continue;
      inline.set(m[1], new Set(
        [...m[2].matchAll(/(?:^|[;{]\s*)(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)].map((f) => f[1]),
      ));
    }
  }
  return { named, inline };
}

/** interface name -> its own fields, plus everything it extends. */
function collectInterfaces(): { fields: Map<string, Set<string>>; extends_: Map<string, string[]> } {
  const fields = new Map<string, Set<string>>();
  const extends_ = new Map<string, string[]>();
  for (const file of ALL_TS) {
    const txt = readFileSync(file, 'utf8');
    for (const m of txt.matchAll(/interface\s+([A-Za-z0-9_]+)([^{]*)\{([^}]*)\}/g)) {
      const [, name, ext, body] = m;
      const set = fields.get(name) ?? new Set<string>();
      for (const f of body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)) set.add(f[1]);
      fields.set(name, set);
      const e = /extends\s+([A-Za-z0-9_,\s]+)/.exec(ext);
      if (e) extends_.set(name, [...(extends_.get(name) ?? []), ...e[1].split(',').map((x) => x.trim())]);
    }
  }
  return { fields, extends_ };
}

describe('syslog subscriptions read fields their payload actually publishes', () => {
  it('no subscription reads a field the event never carries', () => {
    const { named, inline } = collectTopics();
    const { fields, extends_ } = collectInterfaces();

    const fieldsOf = (name: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(name) || !fields.has(name)) return new Set();
      seen.add(name);
      const out = new Set(fields.get(name)!);
      for (const parent of extends_.get(name) ?? []) for (const f of fieldsOf(parent, seen)) out.add(f);
      return out;
    };

    const src = readFileSync(
      join(ROOT, 'network/devices/inspection/config/LoggingConfig.ts'), 'utf8');
    const subscription = /bus\.subscribeWhere\('([^']+)',\s*isOurs,\s*\(e\)\s*=>\s*\{([\s\S]*?)\n {6}\}\)/g;

    const offenders: string[] = [];
    let checked = 0;
    for (const m of src.matchAll(subscription)) {
      const [, topic, body] = m;
      if (!body.includes('as unknown as')) continue;
      const published = named.has(topic) ? fieldsOf(named.get(topic)!) : inline.get(topic);
      if (!published || published.size === 0) continue;
      checked++;
      const missing = [...new Set([...body.matchAll(/\bp\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((f) => f[1]))]
        .filter((f) => !published.has(f))
        .sort();
      if (missing.length > 0) {
        offenders.push(`${topic} reads [${missing.join(', ')}] — payload has [${[...published].sort().join(', ')}]`);
      }
    }

    expect(checked, 'the guard must actually resolve subscriptions, not vacuously pass').toBeGreaterThan(50);
    expect(offenders, `subscriptions rendering '?' instead of a value:\n  ${offenders.join('\n  ')}`).toEqual([]);
    // Ce garde-fou lit l'arborescence des sources au lieu de monter un
    // lab : quelques centaines de millisecondes seul, mais la lecture
    // disque est en concurrence avec les autres fichiers de la passe.
    // Le budget par défaut de 5 s est trop juste pour cela.
  }, 30_000);
});
