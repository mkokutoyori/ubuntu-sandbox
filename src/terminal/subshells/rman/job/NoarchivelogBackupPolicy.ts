let openNoarchivelogBackupAllowed = false;

export function __setOpenNoarchivelogBackupAllowed(on: boolean): void {
  openNoarchivelogBackupAllowed = on;
}

export function openNoarchivelogBackupIsAllowed(): boolean {
  return openNoarchivelogBackupAllowed;
}
