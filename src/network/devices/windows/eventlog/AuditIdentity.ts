let logonIdCounter = 0x10000;

export function nextLogonId(): string {
  logonIdCounter += 1;
  return `0x${logonIdCounter.toString(16)}`;
}

export const MACHINE_SID_PREFIX = 'S-1-5-21-3623811015-3361044348-30300820';

export const SYSTEM_SID = 'S-1-5-18';
export const SYSTEM_LOGON_ID = '0x3E7';

const WELL_KNOWN_SIDS: Record<string, string> = {
  administrator: `${MACHINE_SID_PREFIX}-500`,
  guest: `${MACHINE_SID_PREFIX}-501`,
  defaultaccount: `${MACHINE_SID_PREFIX}-503`,
  system: SYSTEM_SID,
  'local service': 'S-1-5-19',
  'network service': 'S-1-5-20',
};

const WELL_KNOWN_DOMAINS: Record<string, string> = {
  system: 'NT AUTHORITY',
  'local service': 'NT AUTHORITY',
  'network service': 'NT AUTHORITY',
};

export interface AuditSubject {
  readonly sid: string;
  readonly name: string;
  readonly domain: string;
  readonly logonId: string;
}

export interface AuditIdentity {
  readonly machine: string;
  subjectOf(actor: string): AuditSubject;
  sidOf(account: string): string;
  groupSidOf(group: string): { sid: string; domain: string };
  openSession(account: string, logonId: string): void;
}

const BUILTIN_GROUP_SIDS: Record<string, string> = {
  administrators: 'S-1-5-32-544',
  users: 'S-1-5-32-545',
  guests: 'S-1-5-32-546',
  'power users': 'S-1-5-32-547',
  'remote desktop users': 'S-1-5-32-555',
  'network configuration operators': 'S-1-5-32-556',
  'event log readers': 'S-1-5-32-573',
};

function leafOf(account: string): string {
  return account.slice(account.indexOf('\\') + 1);
}

export function createAuditIdentity(
  machine: string,
  lookupSid: (account: string) => string | undefined = () => undefined,
  lookupGroupSid: (group: string) => string | undefined = () => undefined,
): AuditIdentity {
  const sessions = new Map<string, string>();
  const syntheticRids = new Map<string, number>();
  let nextSyntheticRid = 1000;
  const machineAccount = `${machine}$`;

  const sidOf = (account: string): string => {
    const leaf = leafOf(account).toLowerCase();
    return WELL_KNOWN_SIDS[leaf] ?? lookupSid(leafOf(account)) ?? synthetic(leaf);
  };
  const synthetic = (leaf: string): string => {
    let rid = syntheticRids.get(leaf);
    if (rid === undefined) {
      rid = nextSyntheticRid++;
      syntheticRids.set(leaf, rid);
    }
    return `${MACHINE_SID_PREFIX}-${rid}`;
  };

  return {
    machine,
    sidOf,
    subjectOf(actor) {
      const leaf = leafOf(actor);
      const key = leaf.toLowerCase();
      if (key === 'system') {
        return { sid: SYSTEM_SID, name: machineAccount, domain: 'WORKGROUP', logonId: SYSTEM_LOGON_ID };
      }
      const domain = actor.includes('\\') ? actor.slice(0, actor.indexOf('\\')) : (WELL_KNOWN_DOMAINS[key] ?? machine);
      let logonId = sessions.get(key);
      if (logonId === undefined) {
        logonId = nextLogonId();
        sessions.set(key, logonId);
      }
      return { sid: sidOf(actor), name: leaf, domain, logonId };
    },
    groupSidOf(group) {
      const builtin = BUILTIN_GROUP_SIDS[group.toLowerCase()];
      if (builtin !== undefined) return { sid: builtin, domain: 'Builtin' };
      return { sid: lookupGroupSid(group) ?? synthetic(`group:${group.toLowerCase()}`), domain: machine };
    },
    openSession(account, logonId) {
      sessions.set(leafOf(account).toLowerCase(), logonId);
    },
  };
}
