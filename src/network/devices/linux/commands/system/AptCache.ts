/**
 * `apt-cache(8)` — interroge le catalogue de paquets sans rien installer.
 *
 * Le nom était déclaré dans `KNOWN_LINUX_COMMANDS` sans implémentation :
 * `which apt-cache` rendait `/usr/bin/apt-cache` et la commande
 * répondait `command not found` (audit 11, §2).
 *
 * Les données viennent de `packages/PackageDatabase.ts`, la même table
 * que lisent désormais `apt list --installed` et `dpkg -l`. C'est le
 * point : une recherche qui trouverait des paquets que `dpkg -l` ne
 * connaît pas serait pire qu'une commande absente.
 *
 * `search` trie par nom, comme le vrai — sa sortie est faite pour être
 * passée à `grep`, pas pour refléter un ordre de pertinence.
 */

import type { LinuxCommand } from '../LinuxCommand';
import { PACKAGE_DB, searchPackages, findPackage } from '../../packages/PackageDatabase';

const USAGE = `Usage: apt-cache [options] command
       apt-cache [options] show pkg1 [pkg2 ...]

apt-cache queries and displays available information about installed
and installable packages.

Most used commands:
  showpkg - Show some general information for a single package
  stats - Show some basic statistics
  search - Search the package list for a regex pattern
  show - Show a readable record for the package
  depends - Show raw dependency information for a package
  policy - Show policy settings`;

export const aptCacheCommand: LinuxCommand = {
  name: 'apt-cache',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'apt-cache [options] {search|show|showpkg|policy|stats|pkgnames} ...',
  help: 'Query the APT package cache.',
  runWithStatusSync: (_ctx, args) => {
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    const reste = args.filter((a) => !a.startsWith('-') && a !== sub);

    if (sub === '' || sub === 'help') return { output: USAGE, exitCode: sub === '' ? 1 : 0 };

    if (sub === 'search') {
      if (reste.length === 0) return { output: 'E: You must give at least one search pattern', exitCode: 100 };
      const trouves = searchPackages(reste.join(' '))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { output: trouves.map((p) => `${p.name} - ${p.summary}`).join('\n'), exitCode: 0 };
    }

    if (sub === 'pkgnames') {
      const prefixe = reste[0] ?? '';
      return {
        output: PACKAGE_DB.map((p) => p.name).filter((n) => n.startsWith(prefixe)).sort().join('\n'),
        exitCode: 0,
      };
    }

    if (sub === 'stats') {
      const installes = PACKAGE_DB.filter((p) => p.installed).length;
      return {
        output: [
          `Total package names: ${PACKAGE_DB.length} (${PACKAGE_DB.length * 20} B)`,
          `Total package structures: ${PACKAGE_DB.length} (${PACKAGE_DB.length * 30} B)`,
          `  Normal packages: ${PACKAGE_DB.length}`,
          '  Pure virtual packages: 0',
          '  Single virtual packages: 0',
          '  Mixed virtual packages: 0',
          '  Missing: 0',
          `Total distinct versions: ${installes}`,
        ].join('\n'),
        exitCode: 0,
      };
    }

    if (sub === 'show' || sub === 'showpkg' || sub === 'policy' || sub === 'depends') {
      if (reste.length === 0) {
        return { output: `E: No packages found`, exitCode: 100 };
      }
      const blocs: string[] = [];
      let manquant = false;
      for (const nom of reste) {
        const p = findPackage(nom);
        if (!p) {
          blocs.push(`N: Unable to locate package ${nom}`);
          manquant = true;
          continue;
        }
        if (sub === 'policy') {
          blocs.push([
            `${p.name}:`,
            `  Installed: ${p.installed ? p.version : '(none)'}`,
            `  Candidate: ${p.version}`,
            '  Version table:',
            `${p.installed ? ' *** ' : '     '}${p.version} 500`,
            '        500 http://archive.ubuntu.com/ubuntu jammy/main amd64 Packages',
          ].join('\n'));
        } else if (sub === 'showpkg') {
          blocs.push([`Package: ${p.name}`, 'Versions: ', `${p.version} (/var/lib/dpkg/status)`].join('\n'));
        } else if (sub === 'depends') {
          // Aucune relation de dépendance n'est modélisée : la table ne
          // porte que des paquets, pas leur graphe. Le dire vaut mieux
          // que rendre une liste inventée.
          blocs.push(`${p.name}`);
        } else {
          blocs.push([
            `Package: ${p.name}`,
            `Version: ${p.version}`,
            'Priority: optional',
            `Architecture: ${p.arch}`,
            `Description: ${p.summary}`,
            'Origin: Ubuntu',
          ].join('\n'));
        }
      }
      return { output: blocs.join('\n\n'), exitCode: manquant ? 100 : 0 };
    }

    return { output: `E: Invalid operation ${sub}`, exitCode: 100 };
  },
  run: (ctx, args) => (aptCacheCommand.runWithStatusSync!(ctx, args)).output,
};
