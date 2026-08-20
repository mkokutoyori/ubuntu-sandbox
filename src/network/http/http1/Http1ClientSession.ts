import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { HttpMessage } from '../semantics/types';
import { encodeRequest, parseResponse, type Http1EncodeOptions } from './Http1Wire';
import type { IEventBus } from '@/events/EventBus';
import { randomRequestId } from '../events';

export interface Http1SendResult {
  ok: boolean;
  error?: string;
  response?: HttpMessage;
}

/**
 * RFC 9112 §9.3 — HTTP/1.1 connections are persistent by default: a single
 * TCP connection is reused across `send()` calls until either side sends
 * `Connection: close` (or the caller calls `close()`).
 */
export class Http1ClientSession {
  private socket: TcpSocket | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly port = 80,
    private readonly eventBus?: IEventBus,
  ) {}

  private connectIfNeeded(): TcpSocket | null {
    if (this.socket && this.socket.state === 'established') return this.socket;
    const socket = this.tcpStack.connect(this.targetIp, this.port);
    if (!socket || socket.state !== 'established') return null;
    this.socket = socket;
    return socket;
  }

  send(request: HttpMessage, opts?: Http1EncodeOptions): Http1SendResult {
    const requestId = randomRequestId();
    const method = request.method ?? 'GET';
    const target = request.target ?? '';
    this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method, target } });

    const fail = (error: string): Http1SendResult => {
      this.eventBus?.publish({ topic: 'http.request.failed', payload: { requestId, method, target, error } });
      return { ok: false, error };
    };

    const socket = this.connectIfNeeded();
    if (!socket) return fail(`Failed to connect to ${this.targetIp} port ${this.port}: Connection refused`);

    let raw: string | null = null;
    const unsubscribe = socket.onData((data) => { raw = String(data); });
    socket.write(encodeRequest(request, opts));
    unsubscribe();

    if (raw === null) return fail('Empty reply from server');
    const parsed = parseResponse(raw, { suppressBody: request.method === 'HEAD' });
    if (parsed.ok === false) return fail(parsed.reason);

    if (parsed.message.headers.get('Connection')?.toLowerCase() === 'close') {
      this.socket = null;
    }
    this.eventBus?.publish({ topic: 'http.request.completed', payload: { requestId, method, target, statusCode: parsed.message.statusCode ?? 0 } });
    return { ok: true, response: parsed.message };
  }

  /**
   * La même requête, mais en laissant au serveur le droit de RÉFLÉCHIR.
   *
   * `send()` ci-dessus écrit puis se désabonne dans la foulée : il tient
   * pour acquis que la réponse arrive pendant `socket.write()`, ce qui
   * est vrai tant que le gestionnaire du serveur est synchrone — c'est le
   * cas de nginx, d'Apache et d'IIS. Le serveur web d'IOS, lui, peut
   * devoir authentifier par AAA/TACACS+, c'est-à-dire faire un aller-
   * retour TCP avant de pouvoir répondre. Avec le contrat synchrone,
   * cette réponse-là arrivait APRÈS le désabonnement et le client
   * concluait « Empty reply from server » : la fonction paraissait
   * cassée alors que le serveur avait répondu.
   *
   * L'attente est bornée par un nombre de tours de micro-tâches plutôt
   * que par une horloge, et c'est délibéré : dans ce simulateur la
   * livraison des trames est synchrone, donc une chaîne de promesses ne
   * dépend que du nombre de `then` qu'elle traverse, jamais du temps qui
   * passe. Un délai en millisecondes ne se déclencherait pas du tout
   * sous une horloge virtuelle qu'aucun test n'avance.
   */
  async sendAsync(request: HttpMessage, opts?: Http1EncodeOptions): Promise<Http1SendResult> {
    const requestId = randomRequestId();
    const method = request.method ?? 'GET';
    const target = request.target ?? '';
    this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method, target } });

    const fail = (error: string): Http1SendResult => {
      this.eventBus?.publish({ topic: 'http.request.failed', payload: { requestId, method, target, error } });
      return { ok: false, error };
    };

    const socket = this.connectIfNeeded();
    if (!socket) return fail(`Failed to connect to ${this.targetIp} port ${this.port}: Connection refused`);

    let raw: string | null = null;
    const unsubscribe = socket.onData((data) => { raw = String(data); });
    socket.write(encodeRequest(request, opts));
    for (let tour = 0; raw === null && tour < MICROTASK_BUDGET; tour++) {
      await Promise.resolve();
    }
    unsubscribe();

    if (raw === null) return fail('Empty reply from server');
    const parsed = parseResponse(raw, { suppressBody: request.method === 'HEAD' });
    if (parsed.ok === false) return fail(parsed.reason);

    if (parsed.message.headers.get('Connection')?.toLowerCase() === 'close') {
      this.socket = null;
    }
    this.eventBus?.publish({ topic: 'http.request.completed', payload: { requestId, method, target, statusCode: parsed.message.statusCode ?? 0 } });
    return { ok: true, response: parsed.message };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

/**
 * Assez de tours pour la plus longue chaîne qu'un serveur d'ici puisse
 * traverser (authentification AAA, exécution d'une commande, rendu), et
 * assez peu pour qu'un serveur muet rende la main tout de suite.
 */
const MICROTASK_BUDGET = 64;
