export interface WindowsSwitchSet {
  readonly switches: readonly string[];
  readonly valued: readonly string[];
}

export function invalidArgumentError(command: string, token: string): string {
  return `ERROR: Invalid argument/option - '${token}'.\nType "${command.toUpperCase()} /?" for usage.`;
}

export function findInvalidWindowsArgument(args: readonly string[], set: WindowsSwitchSet): string | null {
  for (let at = 0; at < args.length; at++) {
    const token = args[at];
    const lower = token.toLowerCase();
    if (!lower.startsWith('/')) return token;
    if (!set.switches.includes(lower)) return token;
    if (set.valued.includes(lower) && args[at + 1] !== undefined && !args[at + 1].startsWith('/')) at++;
  }
  return null;
}

export const GETMAC_SWITCHES: WindowsSwitchSet = {
  switches: ['/s', '/u', '/p', '/fo', '/nh', '/v', '/?'], valued: ['/s', '/u', '/p', '/fo'],
};
export const TASKLIST_SWITCHES: WindowsSwitchSet = {
  switches: ['/s', '/u', '/p', '/m', '/svc', '/apps', '/v', '/fi', '/fo', '/nh', '/?'],
  valued: ['/s', '/u', '/p', '/m', '/fi', '/fo'],
};
export const SYSTEMINFO_SWITCHES: WindowsSwitchSet = {
  switches: ['/s', '/u', '/p', '/fo', '/nh', '/?'], valued: ['/s', '/u', '/p', '/fo'],
};
