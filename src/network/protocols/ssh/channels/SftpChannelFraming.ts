/**
 * SftpChannelFraming — real binary sub-channel framing for SFTP over the
 * shared SSH `TcpConnection` (PRD-FTP-SFTP.md §2.1.20/P19).
 *
 * Every other message on this connection (`hello`/`auth`/`shell_*`/`exec`/
 * `open_channel`/`close_channel`) is `JSON.stringify(...)` text, which
 * (per `JSON.stringify` on an object) always starts with `{` (0x7B).
 * A frame here always starts with a `\0` (0x00) byte, which can never be
 * the first byte of that JSON text — so a single leading-byte check lets
 * both sides of the connection tell a real `SSH_FXP_*` wire packet apart
 * from every other control message without disturbing any of them.
 *
 * Layout: `0x00` + `uint32` channel id (big-endian) + the exact bytes
 * `encodeSftpWirePacket`/`decodeSftpWirePacket` already produce/consume
 * (which are themselves length-prefixed, per `SftpWireCodec.ts`) — i.e.
 * this is only the channel-multiplexing envelope a real SSH transport
 * would provide via `SSH_MSG_CHANNEL_DATA`'s channel number, layered on
 * top of the already-real wire codec.
 */

const FRAME_TAG = 0x00;
const HEADER_LEN = 5; // 1 tag byte + 4 channel-id bytes

export function isSftpChannelFrame(data: string): boolean {
  return data.length >= HEADER_LEN && data.charCodeAt(0) === FRAME_TAG;
}

export function encodeSftpChannelFrame(channelId: number, wireBytes: Uint8Array): string {
  let out = String.fromCharCode(
    FRAME_TAG,
    (channelId >>> 24) & 0xff,
    (channelId >>> 16) & 0xff,
    (channelId >>> 8) & 0xff,
    channelId & 0xff,
  );
  for (let i = 0; i < wireBytes.length; i++) out += String.fromCharCode(wireBytes[i]);
  return out;
}

export function decodeSftpChannelFrame(data: string): { channelId: number; wireBytes: Uint8Array } {
  const channelId = (
    (data.charCodeAt(1) << 24) | (data.charCodeAt(2) << 16) | (data.charCodeAt(3) << 8) | data.charCodeAt(4)
  ) >>> 0;
  const wireBytes = new Uint8Array(data.length - HEADER_LEN);
  for (let i = 0; i < wireBytes.length; i++) wireBytes[i] = data.charCodeAt(HEADER_LEN + i) & 0xff;
  return { channelId, wireBytes };
}
