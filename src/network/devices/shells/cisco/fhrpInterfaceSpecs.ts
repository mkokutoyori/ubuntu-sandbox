import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { FhrpRepository } from '../../inspection/config/FhrpRepository';
import { hsrpMaxGroup, HSRP_V1_MAX_GROUP } from '../../../hsrp/types';
import {
  getHsrpAgent, getVrrpAgent, getGlbpAgent,
} from '../../../equipment/RouterServiceCapabilities';
import { CISCO_ERRORS } from '../cli-utils';
import {
  HSRP_DEFAULT_PRIORITY, HSRP_DEFAULT_HELLO_SEC, HSRP_DEFAULT_HOLD_SEC,
  VRRP_DEFAULT_PRIORITY, VRRP_DEFAULT_ADVERTISE_SEC, VRRP_DEFAULT_PREEMPT,
  GLBP_DEFAULT_PRIORITY, GLBP_DEFAULT_WEIGHTING, GLBP_DEFAULT_LOAD_BALANCING,
  FHRP_DEFAULT_TRACK_DECREMENT,
} from '../../../fhrp/runningConfig';

export const HSRP_MAX_PRIORITY = 255;
export const HSRP_MIN_PRIORITY = 0;
export const VRRP_MIN_GROUP = 1;
export const VRRP_MAX_GROUP = 255;
export const VRRP_MIN_PRIORITY = 1;
export const VRRP_MAX_PRIORITY = 254;
export const GLBP_MAX_GROUP = 1023;
export const GLBP_MIN_PRIORITY = 1;
export const GLBP_MAX_PRIORITY = 255;
export const GLBP_MIN_WEIGHTING = 1;
export const GLBP_MAX_WEIGHTING = 254;

export type FhrpPlacement = { readonly iface: string } | { readonly refus: string };

export interface FhrpContext {
  device(): object;
  repository(): FhrpRepository;
  placement(protocole: 'HSRP' | 'VRRP' | 'GLBP'): FhrpPlacement;
  resolveTracked(raw: string): string;
}

const MODES = ['config-if', 'config-subif'] as const;

function groupe(description: string, max: number, min = 0): ArgumentSpec {
  return { name: 'groupe', type: 'INT', description, range: [min, max] };
}

function priorite(min: number, max: number): ArgumentSpec {
  return {
    name: 'priorite', type: 'INT', description: 'Priority value',
    range: [min, max],
  };
}

const SECONDES: ArgumentSpec = {
  name: 'secondes', type: 'INT', description: 'Number of seconds',
  range: [0, 3600],
};

const ADRESSE: ArgumentSpec = {
  name: 'adresse', type: 'IP_ADDR', optional: true,
  description: 'Virtual IP address',
};

const CIBLE: ArgumentSpec = {
  name: 'cible', type: 'WORD', description: 'Tracked object number or interface',
};

const DECREMENT: ArgumentSpec = {
  name: 'decrement', type: 'INT', description: 'Priority decrement',
  range: [1, 255],
};

const NOM: ArgumentSpec = { name: 'nom', type: 'WORD', description: 'Group name' };

const CLE: ArgumentSpec = { name: 'cle', type: 'WORD', description: 'Authentication string' };

const POIDS: ArgumentSpec = {
  name: 'poids', type: 'INT', description: 'Maximum weighting value',
  range: [GLBP_MIN_WEIGHTING, GLBP_MAX_WEIGHTING],
};

const SEUIL: ArgumentSpec = {
  name: 'bas', type: 'INT', description: 'Lower weighting threshold',
  range: [1, GLBP_MAX_WEIGHTING],
};

const SEUIL_HAUT: ArgumentSpec = {
  name: 'haut', type: 'INT', description: 'Upper weighting threshold',
  range: [1, GLBP_MAX_WEIGHTING],
};

const REPARTITION: ArgumentSpec = {
  name: 'methode', type: 'ENUM', description: 'Load balancing method',
  values: [
    { keyword: 'host-dependent', description: 'Load balance equally, source MAC determines forwarder choice' },
    { keyword: 'round-robin', description: 'Load balance equally using each forwarder in turn' },
    { keyword: 'weighted', description: 'Load balance in proportion to forwarder weighting' },
  ],
};

function delaiDe(args: Record<string, string | undefined>): number | undefined {
  const brut = args.secondes;
  if (brut === undefined) return undefined;
  const n = Number(brut);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function decrementDe(args: Record<string, string | undefined>): number {
  const n = Number(args.decrement);
  return Number.isFinite(n) && n > 0 ? n : FHRP_DEFAULT_TRACK_DECREMENT;
}

export function fhrpInterfaceSpecs(ctx: FhrpContext): CommandSpec[] {
  function surGroupe(
    protocole: 'HSRP' | 'VRRP' | 'GLBP',
    args: Record<string, string | undefined>,
    appliquer: (repo: FhrpRepository, iface: string, group: number) => string,
  ): string {
    const place = ctx.placement(protocole);
    if ('refus' in place) return place.refus;
    const group = Number(args.groupe);
    if (!Number.isInteger(group)) return CISCO_ERRORS.INVALID_INPUT;
    const repo = ctx.repository();
    if (protocole === 'HSRP') {
      const version = repo.interfaceVersion(place.iface);
      const max = hsrpMaxGroup(version);
      if (group < 0 || group > max) {
        return `% Group number out of range. Valid range is 0-${max} for HSRP version ${version}`;
      }
    }
    return appliquer(repo, place.iface, group);
  }

  const hsrp = (
    args: Record<string, string | undefined>,
    appliquer: (repo: FhrpRepository, iface: string, group: number) => string,
  ) => surGroupe('HSRP', args, (repo, iface, group) => {
    const g = repo.ensure(iface, group);
    getHsrpAgent(ctx.device())?.ensureGroup(iface, group, g.version);
    return appliquer(repo, iface, group);
  });

  const vrrp = (
    args: Record<string, string | undefined>,
    appliquer: (repo: FhrpRepository, iface: string, group: number) => string,
  ) => surGroupe('VRRP', args, (repo, iface, group) => {
    repo.ensureVrrp(iface, group);
    getVrrpAgent(ctx.device())?.ensureGroup(iface, group);
    return appliquer(repo, iface, group);
  });

  const glbp = (
    args: Record<string, string | undefined>,
    appliquer: (repo: FhrpRepository, iface: string, group: number) => string,
  ) => surGroupe('GLBP', args, (repo, iface, group) => {
    repo.ensureGlbp(iface, group);
    getGlbpAgent(ctx.device())?.ensureGroup(iface, group);
    return appliquer(repo, iface, group);
  });

  const poserPoids = (args: Record<string, string | undefined>) =>
    (repo: FhrpRepository, iface: string, group: number): string => {
      const g = repo.ensureGlbp(iface, group);
      g.weighting = Number(args.poids);
      g.weightingLower = args.bas === undefined ? undefined : Number(args.bas);
      g.weightingUpper = args.haut === undefined ? undefined : Number(args.haut);
      getGlbpAgent(ctx.device())?.setWeighting(iface, group, g.weighting);
      return '';
    };

  const GROUPE_HSRP = {
    ...groupe('Group number', hsrpMaxGroup(2)),
    rangeIsAdvisory: true,
  } as ArgumentSpec;
  const GROUPE_VRRP = groupe('Group number', VRRP_MAX_GROUP, VRRP_MIN_GROUP);
  const GROUPE_GLBP = groupe('GLBP group number', GLBP_MAX_GROUP);

  return [
    {
      id: 'standby-version',
      path: ['standby', 'version', {
        name: 'version', type: 'INT', description: 'HSRP version number',
        range: [1, 2],
      }],
      description: 'HSRP version',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        const place = ctx.placement('HSRP');
        if ('refus' in place) return place.refus;
        const v = Number(args.version) === 2 ? 2 : 1;
        const repo = ctx.repository();
        if (v === 1) {
          const trop = repo.forInterface(place.iface)
            .filter((g) => g.group > HSRP_V1_MAX_GROUP);
          if (trop.length > 0) {
            return `% Cannot change to version 1 while group numbers above ${HSRP_V1_MAX_GROUP} exist`;
          }
        }
        repo.setInterfaceVersion(place.iface, v);
        getHsrpAgent(ctx.device())?.setVersion(place.iface, v);
        return '';
      },
    },
    {
      id: 'standby-ip',
      path: ['standby', GROUPE_HSRP, 'ip', ADRESSE],
      description: 'Enable HSRP and set the virtual IP address',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        const g = repo.ensure(iface, group);
        g.vip = args.adresse ?? null;
        const agent = getHsrpAgent(ctx.device());
        if (g.vip) agent?.setVip(iface, group, g.vip);
        else agent?.setVipLearn(iface, group);
        return '';
      }),
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        const g = repo.ensure(iface, group);
        g.vip = null; g.secondary = [];
        return '';
      }),
    },
    {
      id: 'standby-ip-secondary',
      path: ['standby', GROUPE_HSRP, 'ip',
        { name: 'adresse', type: 'IP_ADDR', description: 'Virtual IP address' },
        'secondary'],
      description: 'Enable HSRP and set the virtual IP address',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).secondary.push(args.adresse ?? '');
        return '';
      }),
    },
    {
      id: 'standby-priority',
      path: ['standby', GROUPE_HSRP, 'priority',
        priorite(HSRP_MIN_PRIORITY, HSRP_MAX_PRIORITY)],
      description: 'Priority level',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        const p = Number(args.priorite);
        repo.ensure(iface, group).priority = p;
        getHsrpAgent(ctx.device())?.setPriority(iface, group, p);
        return '';
      }),
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).priority = HSRP_DEFAULT_PRIORITY;
        getHsrpAgent(ctx.device())?.setPriority(iface, group, HSRP_DEFAULT_PRIORITY);
        return '';
      }),
    },
    {
      id: 'standby-preempt',
      path: ['standby', GROUPE_HSRP, 'preempt'],
      description: 'Overthrow lower priority Active routers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).preempt = true;
        getHsrpAgent(ctx.device())?.setPreempt(iface, group, true);
        return '';
      }),
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        const g = repo.ensure(iface, group);
        g.preempt = false; g.preemptDelay = undefined;
        getHsrpAgent(ctx.device())?.setPreempt(iface, group, false);
        return '';
      }),
    },
    {
      id: 'standby-preempt-delay-minimum',
      path: ['standby', GROUPE_HSRP, 'preempt', 'delay', 'minimum', SECONDES],
      description: 'Overthrow lower priority Active routers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        const g = repo.ensure(iface, group);
        g.preempt = true; g.preemptDelay = delaiDe(args);
        getHsrpAgent(ctx.device())?.setPreempt(iface, group, true, g.preemptDelay);
        return '';
      }),
    },
    {
      id: 'standby-timers',
      path: ['standby', GROUPE_HSRP, 'timers',
        { name: 'hello', type: 'INT', description: 'Hello interval in seconds', range: [1, 254] },
        { name: 'hold', type: 'INT', description: 'Hold time in seconds', range: [1, 255] }],
      description: 'Hello and hold timers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        const hello = Number(args.hello); const hold = Number(args.hold);
        if (hold <= hello) return '% Invalid timers (hello >= 1, hold > hello).';
        const g = repo.ensure(iface, group);
        g.helloSec = hello; g.holdSec = hold;
        getHsrpAgent(ctx.device())?.setTimers(iface, group, hello, hold);
        return '';
      }),
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        const g = repo.ensure(iface, group);
        g.helloSec = HSRP_DEFAULT_HELLO_SEC; g.holdSec = HSRP_DEFAULT_HOLD_SEC;
        getHsrpAgent(ctx.device())
          ?.setTimers(iface, group, HSRP_DEFAULT_HELLO_SEC, HSRP_DEFAULT_HOLD_SEC);
        return '';
      }),
    },
    {
      id: 'standby-authentication-text',
      path: ['standby', GROUPE_HSRP, 'authentication', 'text', CLE],
      description: 'Authentication',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).authText = args.cle;
        getHsrpAgent(ctx.device())?.setAuth(iface, group, args.cle ?? '');
        return '';
      }),
    },
    {
      id: 'standby-authentication-plain',
      path: ['standby', GROUPE_HSRP, 'authentication', CLE],
      description: 'Authentication',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).authText = args.cle;
        getHsrpAgent(ctx.device())?.setAuth(iface, group, args.cle ?? '');
        return '';
      }),
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        const g = repo.ensure(iface, group);
        g.authText = undefined; g.authMd5 = undefined;
        return '';
      }),
    },
    {
      id: 'standby-authentication-md5',
      path: ['standby', GROUPE_HSRP, 'authentication', 'md5', 'key-string', CLE],
      description: 'Authentication',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).authMd5 = args.cle;
        return '';
      }),
    },
    {
      id: 'standby-name',
      path: ['standby', GROUPE_HSRP, 'name', NOM],
      description: 'Redundancy name string',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).name = args.nom;
        return '';
      }),
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).name = undefined;
        return '';
      }),
    },
    {
      id: 'standby-follow',
      path: ['standby', GROUPE_HSRP, 'follow', NOM],
      description: 'Name of HSRP group to follow',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).follow = args.nom;
        return '';
      }),
    },
    {
      id: 'standby-track',
      path: ['standby', GROUPE_HSRP, 'track', CIBLE],
      description: 'Priority tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        const target = ctx.resolveTracked(args.cible ?? '');
        repo.ensure(iface, group).trackDecr.push(
          { target, decrement: FHRP_DEFAULT_TRACK_DECREMENT });
        getHsrpAgent(ctx.device())
          ?.addTrack(iface, group, target, FHRP_DEFAULT_TRACK_DECREMENT);
        return '';
      }),
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.ensure(iface, group).trackDecr = [];
        return '';
      }),
    },
    {
      id: 'standby-track-decrement',
      path: ['standby', GROUPE_HSRP, 'track', CIBLE, 'decrement', DECREMENT],
      description: 'Priority tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => hsrp(args, (repo, iface, group) => {
        const target = ctx.resolveTracked(args.cible ?? '');
        const decrement = decrementDe(args);
        repo.ensure(iface, group).trackDecr.push({ target, decrement });
        getHsrpAgent(ctx.device())?.addTrack(iface, group, target, decrement);
        return '';
      }),
    },
    {
      id: 'standby-groupe',
      path: ['standby', GROUPE_HSRP],
      description: 'HSRP configuration',
      existsOnlyNegated: true,
      modes: MODES, minPrivilege: 15,
      run: () => CISCO_ERRORS.INCOMPLETE,
      undo: (_session, args) => hsrp(args, (repo, iface, group) => {
        repo.remove(iface, group);
        getHsrpAgent(ctx.device())?.removeGroup(iface, group);
        return '';
      }),
    },

    {
      id: 'vrrp-ip',
      path: ['vrrp', GROUPE_VRRP, 'ip',
        { name: 'adresse', type: 'IP_ADDR', description: 'Virtual IP address' }],
      description: 'Enable VRRP and set the virtual IP address',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).vip = args.adresse ?? null;
        getVrrpAgent(ctx.device())?.setVip(iface, group, args.adresse ?? '');
        return '';
      }),
      undo: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).vip = null;
        return '';
      }),
    },
    {
      id: 'vrrp-priority',
      path: ['vrrp', GROUPE_VRRP, 'priority',
        priorite(VRRP_MIN_PRIORITY, VRRP_MAX_PRIORITY)],
      description: 'Priority level',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        const p = Number(args.priorite);
        repo.ensureVrrp(iface, group).priority = p;
        getVrrpAgent(ctx.device())?.setPriority(iface, group, p);
        return '';
      }),
      undo: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).priority = VRRP_DEFAULT_PRIORITY;
        getVrrpAgent(ctx.device())?.setPriority(iface, group, VRRP_DEFAULT_PRIORITY);
        return '';
      }),
    },
    {
      id: 'vrrp-preempt',
      path: ['vrrp', GROUPE_VRRP, 'preempt'],
      description: 'Overthrow lower priority Master routers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).preempt = true;
        getVrrpAgent(ctx.device())?.setPreempt(iface, group, true);
        return '';
      }),
      undo: (_session, args) => vrrp(args, (repo, iface, group) => {
        const g = repo.ensureVrrp(iface, group);
        g.preempt = false; g.preemptDelay = undefined;
        getVrrpAgent(ctx.device())?.setPreempt(iface, group, false);
        return '';
      }),
    },
    {
      id: 'vrrp-preempt-delay-minimum',
      path: ['vrrp', GROUPE_VRRP, 'preempt', 'delay', 'minimum', SECONDES],
      description: 'Overthrow lower priority Master routers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        const g = repo.ensureVrrp(iface, group);
        g.preempt = true; g.preemptDelay = delaiDe(args);
        getVrrpAgent(ctx.device())?.setPreempt(iface, group, true, g.preemptDelay);
        return '';
      }),
    },
    {
      id: 'vrrp-timers-advertise',
      path: ['vrrp', GROUPE_VRRP, 'timers', 'advertise',
        { name: 'secondes', type: 'INT', description: 'Advertisement interval in seconds', range: [1, 255] }],
      description: 'Set the timers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        const sec = Number(args.secondes);
        repo.ensureVrrp(iface, group).advertiseSec = sec;
        getVrrpAgent(ctx.device())?.setAdvertiseSec(iface, group, sec);
        return '';
      }),
      undo: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).advertiseSec = VRRP_DEFAULT_ADVERTISE_SEC;
        getVrrpAgent(ctx.device())
          ?.setAdvertiseSec(iface, group, VRRP_DEFAULT_ADVERTISE_SEC);
        return '';
      }),
    },
    {
      id: 'vrrp-authentication-md5',
      path: ['vrrp', GROUPE_VRRP, 'authentication', 'md5', 'key-string', CLE],
      description: 'Set authentication',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).authMd5 = args.cle;
        getVrrpAgent(ctx.device())?.setAuth(iface, group, 'md5', args.cle);
        return '';
      }),
    },
    {
      id: 'vrrp-authentication-text',
      path: ['vrrp', GROUPE_VRRP, 'authentication', 'text', CLE],
      description: 'Set authentication',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (_repo, iface, group) => {
        getVrrpAgent(ctx.device())?.setAuth(iface, group, 'simple', args.cle);
        return '';
      }),
    },
    {
      id: 'vrrp-description',
      path: ['vrrp', GROUPE_VRRP, 'description',
        { name: 'texte', type: 'REST', description: 'Group description' }],
      description: 'Group specific description',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).description = args.texte;
        return '';
      }),
    },
    {
      id: 'vrrp-track',
      path: ['vrrp', GROUPE_VRRP, 'track', CIBLE],
      description: 'Priority tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        const target = ctx.resolveTracked(args.cible ?? '');
        repo.ensureVrrp(iface, group).trackDecr.push(
          { target, decrement: FHRP_DEFAULT_TRACK_DECREMENT });
        getVrrpAgent(ctx.device())
          ?.addTrack(iface, group, target, FHRP_DEFAULT_TRACK_DECREMENT);
        return '';
      }),
      undo: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.ensureVrrp(iface, group).trackDecr = [];
        return '';
      }),
    },
    {
      id: 'vrrp-track-decrement',
      path: ['vrrp', GROUPE_VRRP, 'track', CIBLE, 'decrement', DECREMENT],
      description: 'Priority tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => vrrp(args, (repo, iface, group) => {
        const target = ctx.resolveTracked(args.cible ?? '');
        const decrement = decrementDe(args);
        repo.ensureVrrp(iface, group).trackDecr.push({ target, decrement });
        getVrrpAgent(ctx.device())?.addTrack(iface, group, target, decrement);
        return '';
      }),
    },
    {
      id: 'vrrp-groupe',
      path: ['vrrp', GROUPE_VRRP],
      description: 'VRRP configuration',
      existsOnlyNegated: true,
      modes: MODES, minPrivilege: 15,
      run: () => CISCO_ERRORS.INCOMPLETE,
      undo: (_session, args) => vrrp(args, (repo, iface, group) => {
        repo.removeVrrp(iface, group);
        getVrrpAgent(ctx.device())?.removeGroup(iface, group);
        return '';
      }),
    },

    {
      id: 'glbp-ip',
      path: ['glbp', GROUPE_GLBP, 'ip', ADRESSE],
      description: 'Enable GLBP and set the virtual IP address',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).vip = args.adresse ?? null;
        if (args.adresse) getGlbpAgent(ctx.device())?.setVip(iface, group, args.adresse);
        return '';
      }),
      undo: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).vip = null;
        return '';
      }),
    },
    {
      id: 'glbp-priority',
      path: ['glbp', GROUPE_GLBP, 'priority',
        priorite(GLBP_MIN_PRIORITY, GLBP_MAX_PRIORITY)],
      description: 'Priority level',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        const p = Number(args.priorite);
        repo.ensureGlbp(iface, group).priority = p;
        getGlbpAgent(ctx.device())?.setPriority(iface, group, p);
        return '';
      }),
      undo: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).priority = GLBP_DEFAULT_PRIORITY;
        getGlbpAgent(ctx.device())?.setPriority(iface, group, GLBP_DEFAULT_PRIORITY);
        return '';
      }),
    },
    {
      id: 'glbp-preempt',
      path: ['glbp', GROUPE_GLBP, 'preempt'],
      description: 'Overthrow lower priority Active routers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).preempt = true;
        getGlbpAgent(ctx.device())?.setPreempt(iface, group, true);
        return '';
      }),
      undo: (_session, args) => glbp(args, (repo, iface, group) => {
        const g = repo.ensureGlbp(iface, group);
        g.preempt = false; g.preemptDelay = undefined;
        getGlbpAgent(ctx.device())?.setPreempt(iface, group, false);
        return '';
      }),
    },
    {
      id: 'glbp-preempt-delay-minimum',
      path: ['glbp', GROUPE_GLBP, 'preempt', 'delay', 'minimum', SECONDES],
      description: 'Overthrow lower priority Active routers',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        const g = repo.ensureGlbp(iface, group);
        g.preempt = true; g.preemptDelay = delaiDe(args);
        getGlbpAgent(ctx.device())?.setPreempt(iface, group, true, g.preemptDelay);
        return '';
      }),
    },
    {
      id: 'glbp-weighting',
      path: ['glbp', GROUPE_GLBP, 'weighting', POIDS],
      description: 'Gateway weighting and tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, poserPoids(args)),
      undo: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).weighting = GLBP_DEFAULT_WEIGHTING;
        getGlbpAgent(ctx.device())?.setWeighting(iface, group, GLBP_DEFAULT_WEIGHTING);
        return '';
      }),
    },
    {
      id: 'glbp-weighting-lower',
      path: ['glbp', GROUPE_GLBP, 'weighting', POIDS, 'lower', SEUIL],
      description: 'Gateway weighting and tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, poserPoids(args)),
    },
    {
      id: 'glbp-weighting-upper',
      path: ['glbp', GROUPE_GLBP, 'weighting', POIDS, 'upper', SEUIL_HAUT],
      description: 'Gateway weighting and tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, poserPoids(args)),
    },
    {
      id: 'glbp-weighting-lower-upper',
      path: ['glbp', GROUPE_GLBP, 'weighting', POIDS,
        'lower', SEUIL, 'upper', SEUIL_HAUT],
      description: 'Gateway weighting and tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, poserPoids(args)),
    },
    {
      id: 'glbp-weighting-track',
      path: ['glbp', GROUPE_GLBP, 'weighting', 'track', CIBLE],
      description: 'Gateway weighting and tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        const target = ctx.resolveTracked(args.cible ?? '');
        repo.ensureGlbp(iface, group).trackDecr.push(
          { target, decrement: FHRP_DEFAULT_TRACK_DECREMENT });
        getGlbpAgent(ctx.device())
          ?.addTrack(iface, group, target, FHRP_DEFAULT_TRACK_DECREMENT);
        return '';
      }),
      undo: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).trackDecr = [];
        return '';
      }),
    },
    {
      id: 'glbp-weighting-track-decrement',
      path: ['glbp', GROUPE_GLBP, 'weighting', 'track', CIBLE, 'decrement', DECREMENT],
      description: 'Gateway weighting and tracking',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        const target = ctx.resolveTracked(args.cible ?? '');
        const decrement = decrementDe(args);
        repo.ensureGlbp(iface, group).trackDecr.push({ target, decrement });
        getGlbpAgent(ctx.device())?.addTrack(iface, group, target, decrement);
        return '';
      }),
    },
    {
      id: 'glbp-load-balancing',
      path: ['glbp', GROUPE_GLBP, 'load-balancing', REPARTITION],
      description: 'Load balancing method',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        const mode = args.methode ?? GLBP_DEFAULT_LOAD_BALANCING;
        repo.ensureGlbp(iface, group).loadBalancing = mode;
        getGlbpAgent(ctx.device())?.setLoadBalancing(
          iface, group, mode as 'round-robin' | 'weighted' | 'host-dependent');
        return '';
      }),
      undo: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).loadBalancing = GLBP_DEFAULT_LOAD_BALANCING;
        getGlbpAgent(ctx.device())?.setLoadBalancing(
          iface, group, GLBP_DEFAULT_LOAD_BALANCING as 'round-robin');
        return '';
      }),
    },
    {
      id: 'glbp-authentication-text',
      path: ['glbp', GROUPE_GLBP, 'authentication', 'text', CLE],
      description: 'Set authentication',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        getGlbpAgent(ctx.device())?.setAuth(iface, group, 'text', args.cle ?? '');
        return '';
      }),
    },
    {
      id: 'glbp-authentication-md5',
      path: ['glbp', GROUPE_GLBP, 'authentication', 'md5', 'key-string', CLE],
      description: 'Set authentication',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).authMd5 = args.cle;
        getGlbpAgent(ctx.device())?.setAuth(iface, group, 'md5', args.cle ?? '');
        return '';
      }),
    },
    {
      id: 'glbp-name',
      path: ['glbp', GROUPE_GLBP, 'name', NOM],
      description: 'Redundancy name string',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.ensureGlbp(iface, group).name = args.nom;
        return '';
      }),
    },
    {
      id: 'glbp-forwarder-preempt',
      path: ['glbp', GROUPE_GLBP, 'forwarder', 'preempt'],
      description: 'Forwarder configuration',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, () => ''),
    },
    {
      id: 'glbp-forwarder-preempt-delay-minimum',
      path: ['glbp', GROUPE_GLBP, 'forwarder', 'preempt', 'delay', 'minimum', SECONDES],
      description: 'Forwarder configuration',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => glbp(args, () => ''),
    },
    {
      id: 'glbp-groupe',
      path: ['glbp', GROUPE_GLBP],
      description: 'GLBP configuration',
      existsOnlyNegated: true,
      modes: MODES, minPrivilege: 15,
      run: () => CISCO_ERRORS.INCOMPLETE,
      undo: (_session, args) => glbp(args, (repo, iface, group) => {
        repo.removeGlbp(iface, group);
        getGlbpAgent(ctx.device())?.removeGroup(iface, group);
        return '';
      }),
    },
  ];
}
