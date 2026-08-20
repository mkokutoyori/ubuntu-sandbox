/**
 * LpdTransport — RFC 1179 Line Printer Daemon protocol, real byte framing
 * (PRD-Windows-Server-Advanced.md §5 P20, §2.1.19): TCP/515, the three
 * commands the PRD names by name — `01` Print any waiting jobs, `02`
 * Receive a printer job (with `02`/`03` sub-commands to receive the
 * control file then the data file), `03` Send queue state (short). No
 * real document rendering: once a job's control+data files are fully
 * received, its metadata is handed to `PrintServerRole.submitJob`, which
 * is all this simulator ever models of "printing".
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { WindowsPrintServerRole } from './PrintServerRole';

export const LPD_PORT = 515;

const CMD_PRINT_WAITING_JOBS = 0x01;
const CMD_RECEIVE_JOB = 0x02;
const CMD_SEND_QUEUE_STATE_SHORT = 0x03;
const SUB_RECEIVE_CONTROL_FILE = 0x02;
const SUB_RECEIVE_DATA_FILE = 0x03;
const ACK_OK = 0x00;
const ACK_ERROR = 0x01;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const text = String(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function toText(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function line(opcode: number, operand: string): Uint8Array {
  return toBytes(String.fromCharCode(opcode) + operand + '\n');
}

function ack(ok: boolean): Uint8Array {
  return Uint8Array.of(ok ? ACK_OK : ACK_ERROR);
}

/** Strips the trailing single zero-byte terminator RFC 1179 requires after every transferred file. */
function stripTerminator(bytes: Uint8Array): Uint8Array {
  return bytes.length > 0 && bytes[bytes.length - 1] === 0 ? bytes.subarray(0, bytes.length - 1) : bytes;
}

function withTerminator(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  out[bytes.length] = 0;
  return out;
}

/** Minimal RFC 1179 §4 control file: just enough (`H`ost/`P`erson/`N`ame lines) to recover owner + document name server-side. */
function buildControlFile(hostname: string, owner: string, documentName: string): string {
  return `H${hostname}\nP${owner}\nN${documentName}\n`;
}

function parseControlFile(text: string): { owner: string; documentName: string } {
  let owner = 'unknown';
  let documentName = 'document';
  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith('P')) owner = rawLine.slice(1);
    else if (rawLine.startsWith('N')) documentName = rawLine.slice(1);
  }
  return { owner, documentName };
}

type LpdStage = 'idle' | 'awaitingCtrlHeader' | 'awaitingCtrlBody' | 'awaitingDataHeader' | 'awaitingDataBody';

/** Server side — one TCP/515 connection's RFC 1179 state machine. */
export class LpdServerHandler {
  constructor(private readonly role: WindowsPrintServerRole) {}

  register(socket: TcpSocket): void {
    let stage: LpdStage = 'idle';
    let queueName = '';
    let ctrlContent = '';

    socket.onData((data) => {
      const bytes = toBytes(data);
      const opcode = bytes[0];
      const operand = toText(bytes.subarray(1)).replace(/\n$/, '');

      if (stage === 'idle') {
        if (opcode === CMD_PRINT_WAITING_JOBS) {
          // No real print head to kick — RFC 1179 sends no reply for this command.
          socket.close();
          return;
        }
        if (opcode === CMD_SEND_QUEUE_STATE_SHORT) {
          const jobs = this.role.listJobs(operand);
          const listing = jobs.length === 0
            ? 'no entries\n'
            : jobs.map((j) => `${j.status.padEnd(10)} ${j.owner.padEnd(16)} ${j.id.toString().padEnd(6)} ${j.document.padEnd(24)} ${j.size} bytes\n`).join('');
          socket.send(toBytes(listing));
          socket.close();
          return;
        }
        if (opcode === CMD_RECEIVE_JOB) {
          queueName = operand;
          socket.send(ack(this.role.hasPrinter(queueName)));
          stage = 'awaitingCtrlHeader';
        }
        return;
      }

      if (stage === 'awaitingCtrlHeader') {
        // sub-command 02: "<count> <cfName>\n" — count is advisory only (we trust the terminator).
        if (opcode !== SUB_RECEIVE_CONTROL_FILE) return;
        socket.send(ack(true));
        stage = 'awaitingCtrlBody';
        return;
      }

      if (stage === 'awaitingCtrlBody') {
        ctrlContent = toText(stripTerminator(bytes));
        socket.send(ack(true));
        stage = 'awaitingDataHeader';
        return;
      }

      if (stage === 'awaitingDataHeader') {
        if (opcode !== SUB_RECEIVE_DATA_FILE) return;
        socket.send(ack(true));
        stage = 'awaitingDataBody';
        return;
      }

      if (stage === 'awaitingDataBody') {
        const content = stripTerminator(bytes);
        const { owner, documentName } = parseControlFile(ctrlContent);
        this.role.submitJob(queueName, documentName, owner, content.length);
        socket.send(ack(true));
        stage = 'idle';
      }
    });
  }
}

export interface LpdSubmitResult { ok: boolean; error?: string }

/**
 * Client side — one full RFC 1179 job submission: `Receive a printer job`,
 * then its control file, then its data file. Relies on this simulator's
 * synchronous same-tick `send()`/`onData()` delivery between directly
 * reachable hosts (same convention as `dialRdp`'s sequential round trips).
 */
export function submitLpdPrintJob(
  tcpStack: TcpStack, serverAddress: string, queueName: string,
  documentName: string, owner: string, hostname: string, contentBytes: Uint8Array,
): LpdSubmitResult {
  const socket = tcpStack.connect(serverAddress, LPD_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: `lpr: could not connect to ${serverAddress}:${LPD_PORT}` };
  }

  let jobAck: Uint8Array | null = null;
  let unsub = socket.onData((d) => { jobAck = toBytes(d); });
  socket.send(line(CMD_RECEIVE_JOB, queueName));
  unsub();
  if (!jobAck || (jobAck as Uint8Array)[0] !== ACK_OK) {
    socket.close();
    return { ok: false, error: `lpr: queue "${queueName}" does not exist on ${serverAddress}` };
  }

  const ctrlFile = toBytes(buildControlFile(hostname, owner, documentName));
  let ctrlHeaderAck: Uint8Array | null = null;
  unsub = socket.onData((d) => { ctrlHeaderAck = toBytes(d); });
  socket.send(line(SUB_RECEIVE_CONTROL_FILE, `${ctrlFile.length} cfA001${hostname}`));
  unsub();
  if (!ctrlHeaderAck || (ctrlHeaderAck as Uint8Array)[0] !== ACK_OK) {
    socket.close();
    return { ok: false, error: 'lpr: control file rejected' };
  }

  let ctrlBodyAck: Uint8Array | null = null;
  unsub = socket.onData((d) => { ctrlBodyAck = toBytes(d); });
  socket.send(withTerminator(ctrlFile));
  unsub();
  if (!ctrlBodyAck || (ctrlBodyAck as Uint8Array)[0] !== ACK_OK) {
    socket.close();
    return { ok: false, error: 'lpr: control file transfer failed' };
  }

  let dataHeaderAck: Uint8Array | null = null;
  unsub = socket.onData((d) => { dataHeaderAck = toBytes(d); });
  socket.send(line(SUB_RECEIVE_DATA_FILE, `${contentBytes.length} dfA001${hostname}`));
  unsub();
  if (!dataHeaderAck || (dataHeaderAck as Uint8Array)[0] !== ACK_OK) {
    socket.close();
    return { ok: false, error: 'lpr: data file rejected' };
  }

  let dataBodyAck: Uint8Array | null = null;
  unsub = socket.onData((d) => { dataBodyAck = toBytes(d); });
  socket.send(withTerminator(contentBytes));
  unsub();
  socket.close();
  if (!dataBodyAck || (dataBodyAck as Uint8Array)[0] !== ACK_OK) {
    return { ok: false, error: 'lpr: data file transfer failed' };
  }
  return { ok: true };
}

/** `Send queue state (short)` — one line per job, or `no entries`. */
export function queryLpdQueueState(tcpStack: TcpStack, serverAddress: string, queueName: string): string | null {
  const socket = tcpStack.connect(serverAddress, LPD_PORT);
  if (!socket || socket.state !== 'established') return null;

  let response: Uint8Array | null = null;
  const unsub = socket.onData((d) => { response = toBytes(d); });
  socket.send(line(CMD_SEND_QUEUE_STATE_SHORT, queueName));
  unsub();
  socket.close();
  return response ? toText(response) : null;
}
