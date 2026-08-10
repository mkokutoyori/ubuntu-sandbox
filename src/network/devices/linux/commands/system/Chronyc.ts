/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — `chronyc`, le §5.3 du tutoriel.
 *
 * La commande n'existait pas (`chronyc: command not found`) sur une
 * machine dont `dpkg` declarait le paquet installe.
 *
 * Elle parle au demon, et non a l'agent directement : sans chronyd,
 * elle repond `506 Cannot talk to daemon`, ce qui est la vraie reponse
 * et la premiere chose qu'un lab de depannage doit pouvoir montrer.
 */
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import {
  chronycTracking, chronycSources, chronycSourcestats, chronycActivity, chronycServerstats,
  CHRONYC_SANS_DEMON,
} from '../../time/ChronycViews';

/** Les sous-commandes que ce build implemente. */
const CONNUES = ['tracking', 'sources', 'sourcestats', 'activity', 'makestep', 'reload',
  'serverstats'];

export const chronycCommand: LinuxCommand = {
  name: 'chronyc',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/chronyc',
  usage: 'chronyc [-n] [-v] <command>',
  run(ctx: LinuxCommandContext, argv: string[]): string {
    const args = argv.filter((a) => !a.startsWith('-'));
    const verbose = argv.includes('-v');
    const service = ctx.executor.chronyService;
    const agent = service ? ctx.executor.ntpAgent?.() : null;
    if (!service || !agent) return CHRONYC_SANS_DEMON;

    const sous = (args[0] ?? '').toLowerCase();
    // `chronyc` sans argument ouvre une invite interactive ; ce terminal
    // n'en a pas, donc la forme sans sous-commande est refusee plutot
    // que d'ouvrir un shell dont on ne pourrait pas sortir.
    if (!sous) return 'chronyc: no command given (interactive mode is not available here)';
    if (!CONNUES.includes(sous)) {
      return `chronyc: unknown command "${sous}"`;
    }
    if (!service.isRunning()) return CHRONYC_SANS_DEMON;

    switch (sous) {
      case 'tracking': return chronycTracking(agent);
      case 'sources': return chronycSources(agent, verbose);
      case 'sourcestats': return chronycSourcestats(agent);
      case 'activity': return chronycActivity(agent);
      case 'serverstats': return chronycServerstats(agent);
      case 'reload': {
        const r = service.reload();
        return r.ok === true ? '200 OK' : r.erreur;
      }
      case 'makestep': {
        const r = service.makestep();
        if (r.ok === false) return r.erreur;
        // Un saut consomme la mesure courante : la vraie commande force
        // une nouvelle interrogation, et sans elle `tracking` rendrait
        // l'ancien ecart juste apres avoir annonce l'avoir corrige.
        agent.pollAll();
        return '200 OK';
      }
      default: return '';
    }
  },
};
