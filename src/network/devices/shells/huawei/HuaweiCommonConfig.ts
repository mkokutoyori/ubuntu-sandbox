/**
 * HuaweiCommonConfig — VRP lifecycle / management commands identical on
 * switches and routers (save, reboot, reset saved-configuration, commit,
 * screen-length, header banner).
 *
 * The simulator is non-interactive, so the Y/N confirmation prompts are
 * skipped and only the final result line is returned. Single source of
 * truth so HuaweiSwitchShell and HuaweiVRPShell don't duplicate it (DRY).
 */

import type { CommandTrie } from '../CommandTrie';
import type { HuaweiDebugService } from '../../router/diag/HuaweiDebugService';
import {
  type HuaweiDebugLookup,
  type HuaweiDebugPlatform,
  categoriesDeLaPlateforme,
  resoudreDebugHuawei,
} from '../../router/diag/huaweiDebugCatalog';
import { HUAWEI_ERRORS } from '../cli-utils';

/** `save` / `save force` — persist running config to "flash". */
export function saveConfiguration(): string {
  return [
    'Warning: The current configuration will be written to the device.',
    'Now saving the current configuration to the slot 0.',
    'Save the configuration successfully.',
  ].join('\n');
}

/** `reset saved-configuration` — erase the startup config. */
export function resetSavedConfiguration(): string {
  return 'Info: Succeeded in clearing the configuration in the device.';
}

/** `reboot` — acknowledge (the sim does not actually power-cycle). */
export function rebootDevice(): string {
  return 'Info: The system is now comparing the configuration, please wait.\nInfo: System will reboot.';
}

/** `commit` — two-stage commit; a no-op success in the sim. */
export function commitConfiguration(): string {
  return '';
}

/**
 * `screen-length <n> [temporary]` / `screen-length disable` — terminal
 * paging. No paging in the sim, so this is a recognised no-op.
 */
export function screenLength(): string {
  return '';
}

/**
 * `header {login|shell} information <text>` — banner text. Accepted and
 * stored by the caller if it cares; here it's a recognised no-op so the
 * CLI does not reject it.
 */
export function setHeader(): string {
  return '';
}

/**
 * Register the VRP lifecycle / management commands on a CommandTrie.
 * Called by BOTH HuaweiSwitchShell and HuaweiVRPShell so the wiring
 * itself isn't duplicated (DRY).
 */
export function registerHuaweiCommonMgmt(
  trie: CommandTrie,
  debug?: { service: () => HuaweiDebugService | null; platform: HuaweiDebugPlatform },
  onSave?: () => void,
  onResetSaved?: () => void,
): void {
  if (debug) registerHuaweiDebugging(trie, debug.service, debug.platform);
  trie.registerGreedy('save', 'Save current configuration', () => {
    onSave?.();
    return saveConfiguration();
  });
  trie.register('reboot', 'Reboot the device', () => rebootDevice());
  trie.register('reset saved-configuration', 'Erase startup configuration', () => {
    onResetSaved?.();
    return resetSavedConfiguration();
  });
  trie.register('commit', 'Commit candidate configuration', () => commitConfiguration());
  trie.registerGreedy('screen-length', 'Set terminal screen length', () => screenLength());
  trie.registerGreedy('header', 'Configure login/shell banner', () => setHeader());
  trie.register('terminal monitor', 'Enable terminal monitoring', () => 'Info: Current terminal monitor is on.');
  trie.register('undo terminal monitor', 'Disable terminal monitoring', () => 'Info: Current terminal monitor is off.');
  trie.register('terminal debugging', 'Enable terminal debugging', () => 'Info: Current terminal debugging is on.');
  trie.register('undo terminal debugging', 'Disable terminal debugging', () => 'Info: Current terminal debugging is off.');
}

/**
 * `debugging` / `undo debugging` — un seul enregistrement, pour les deux
 * plateformes et pour TOUTES les vues.
 *
 * Avant, la meme commande etait enregistree a trois endroits : le
 * fourre-tout glouton ci-dessus (qui rangeait la phrase deja rendue dans
 * un `Set` sans proprietaire), les formes OSPF de `HuaweiOspfCommands`,
 * et les formes du routeur dans `HuaweiVRPShell`. Consequence mesuree :
 * `debugging ospf spf` marchait en vue utilisateur et etait REFUSE en
 * vue systeme, `debugging icmp` et `debugging ip icmp` designaient le
 * meme sujet dans deux magasins distincts, et `debugging zzz` etait
 * accepte.
 */
export function registerHuaweiDebugging(
  trie: CommandTrie,
  service: () => HuaweiDebugService | null,
  plateforme: HuaweiDebugPlatform,
): void {
  const refus = (r: HuaweiDebugLookup, ligne: string): string | null => {
    switch (r.kind) {
      case 'incomplete':
        return HUAWEI_ERRORS.INCOMPLETE(ligne);
      case 'sans-source':
        return `Error: ${r.raison}`;
      case 'autre-plateforme':
      case 'inconnu': {
        const pos = ligne.toLowerCase().indexOf(r.token.toLowerCase());
        return HUAWEI_ERRORS.UNRECOGNIZED(ligne, pos < 0 ? ligne.length : pos);
      }
      default:
        return null;
    }
  };

  // Chaque ecriture canonique est un VRAI chemin de la trie, et pas
  // seulement une branche du fourre-tout : sans cela `debugging ip icmp`
  // est avale par `debugging ipsec`, dont `ip` est un prefixe non
  // ambigu — defaut mesure en retirant les anciens noeuds litteraux.
  // C'est aussi ce qui rend ces formes decouvrables par `?`.
  for (const spec of categoriesDeLaPlateforme(plateforme)) {
    const chemin = spec.words.join(' ');
    trie.registerGreedy(`debugging ${chemin}`, `Enable ${spec.label} debugging`, (args) => {
      const svc = service();
      return svc ? svc.enable(spec.category, args.length ? args.join(' ') : undefined) : '';
    });
    trie.registerGreedy(`undo debugging ${chemin}`, `Disable ${spec.label} debugging`, () => {
      const svc = service();
      return svc ? svc.disable(spec.category) : '';
    });
  }

  trie.registerGreedy('debugging', 'Enable system debugging functions', (args, raw) => {
    const svc = service();
    if (!svc) return '';
    const ligne = raw?.trim() || `debugging ${args.join(' ')}`.trim();
    const r = resoudreDebugHuawei(args, svc.getPlatform());
    return r.kind === 'ok'
      ? svc.enable(r.spec.category, r.scope ?? undefined)
      : (refus(r, ligne) ?? '');
  });

  trie.registerGreedy('undo debugging', 'Disable system debugging functions', (args, raw) => {
    const svc = service();
    if (!svc) return '';
    const ligne = raw?.trim() || `undo debugging ${args.join(' ')}`.trim();
    if (args.length && args[0].toLowerCase() === 'all') return svc.disableAll();
    const r = resoudreDebugHuawei(args, svc.getPlatform());
    return r.kind === 'ok' ? svc.disable(r.spec.category) : (refus(r, ligne) ?? '');
  });
}
