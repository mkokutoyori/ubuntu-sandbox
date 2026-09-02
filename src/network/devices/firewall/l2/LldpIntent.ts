export type LldpSetting = 'enable' | 'disable' | 'vdom';

export type LldpVdomSetting = 'enable' | 'disable' | 'global';

export interface LldpIntent {
  readonly tx: LldpSetting;
  readonly rx: LldpSetting;
}

export interface LldpVdomIntent {
  readonly tx: LldpVdomSetting;
  readonly rx: LldpVdomSetting;
}

export function resolveLldp(
  iface: LldpSetting,
  vdom: LldpVdomSetting,
  global: boolean,
): boolean {
  if (iface !== 'vdom') return iface === 'enable';
  if (vdom !== 'global') return vdom === 'enable';
  return global;
}
