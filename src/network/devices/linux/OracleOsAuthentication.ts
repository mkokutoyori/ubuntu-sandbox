let superuserIsOsdba = false;

export function __setSuperuserIsOsdba(on: boolean): void {
  superuserIsOsdba = on;
}

export function superuserAdmittedAsOsdba(): boolean {
  return superuserIsOsdba;
}
