/**
 * `ver.exe` output body — single source shared by `WindowsPC.runSyncNativeCommand`
 * (PowerShell's synchronous native passthrough) and the command-kernel
 * `VerCommand` (cmd.exe), so both shells stay coherent. Not yet
 * differentiated by device type (client vs server) — `getIdentity()`
 * already carries that real per-device data for `systeminfo`/`wmic os get
 * caption`, but the exact build/UBR suffix (`.6649`) has no equivalent
 * field there yet; wiring `ver` to it is tracked as follow-up work.
 */
export const WIN_VER_STRING = '\nMicrosoft Windows [Version 10.0.22631.6649]';
