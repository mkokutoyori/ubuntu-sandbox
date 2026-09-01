export type LldpSetting = 'enable' | 'disable' | 'vdom';

export interface LldpIntent {
  readonly tx: LldpSetting;
  readonly rx: LldpSetting;
}
