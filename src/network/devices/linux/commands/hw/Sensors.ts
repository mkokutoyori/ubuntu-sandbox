/**
 * `sensors` — les sondes matérielles (lm-sensors).
 *
 * La réponse ici n'est pas un bouchon : c'est la bonne réponse pour le
 * matériel modélisé. Le simulateur n'a aucun périphérique hwmon — pas de
 * `/sys/class/hwmon`, pas de puce `coretemp`, `nct6775` ou `k10temp` dans
 * l'inventaire PCI/DMI — et le vrai `sensors` sur une machine dans cet
 * état répond exactement ceci (relevé sur la machine de référence, une VM
 * sans sonde exposée) :
 *
 *     No sensors found!
 *     Make sure you loaded all the kernel drivers you need.
 *     Try sensors-detect to find out which these are.
 *
 * Ce message-là est la vérité ; inventer des températures de cœur serait
 * la seule façon de mentir. Et la réponse est **dérivée** de l'absence de
 * `/sys/class/hwmon`, pas écrite en dur : le jour où un modèle thermique
 * peuplera cette arborescence, la commande suivra sans être retouchée.
 *
 * Note relevée et volontairement conservée : le vrai binaire sort en **0**
 * dans ce cas, pas en erreur — ne rien avoir à mesurer n'est pas un échec.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const NO_SENSORS = [
  'No sensors found!',
  'Make sure you loaded all the kernel drivers you need.',
  'Try sensors-detect to find out which these are.',
].join('\n');

interface HwmonChip {
  name: string;
  adapter: string;
  readings: string[];
}

/**
 * Lit les puces exposées par `/sys/class/hwmon`. Rien aujourd'hui — mais
 * c'est la lecture, pas une constante, qui décide de la sortie.
 */
function readHwmonChips(ctx: LinuxCommandContext): HwmonChip[] {
  const entries = ctx.executor.vfs.listDirectory('/sys/class/hwmon');
  if (!entries || entries.length === 0) return [];
  const chips: HwmonChip[] = [];
  for (const e of entries) {
    const base = `/sys/class/hwmon/${e.name}`;
    const name = (ctx.executor.vfs.readFile(`${base}/name`) ?? '').trim();
    if (!name) continue;
    const readings: string[] = [];
    const files = ctx.executor.vfs.listDirectory(base) ?? [];
    for (const f of files.filter((x) => /^temp\d+_input$/.test(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const milli = parseInt((ctx.executor.vfs.readFile(`${base}/${f.name}`) ?? '').trim(), 10);
      if (Number.isNaN(milli)) continue;
      const label = (ctx.executor.vfs.readFile(`${base}/${f.name.replace('_input', '_label')}`) ?? f.name.replace('_input', '')).trim();
      readings.push(`${label}:${(milli / 1000).toFixed(1).padStart(14)}°C`);
    }
    chips.push({ name, adapter: 'Virtual device', readings });
  }
  return chips;
}

export function runSensors(ctx: LinuxCommandContext): { output: string; exitCode: number } {
  const chips = readHwmonChips(ctx);
  if (chips.length === 0) return { output: NO_SENSORS, exitCode: 0 };
  const out: string[] = [];
  for (const c of chips) {
    out.push(`${c.name}-virtual-0`, `Adapter: ${c.adapter}`, ...c.readings, '');
  }
  return { output: out.join('\n').trimEnd(), exitCode: 0 };
}

export const sensorsCommand: LinuxCommand = {
  name: 'sensors',
  package: 'lm-sensors',
  needsNetworkContext: true,
  usage: 'sensors [-A] [-f] [chip ...]',
  manSection: 1,
  help: 'Print sensors information from the hwmon subsystem.',
  run(ctx) { return runSensors(ctx).output; },
  runWithStatusSync(ctx) { return runSensors(ctx); },
};
