/**
 * L'interface web d'IOS (`docs/PRD-Serveur-HTTP-Cisco.md` §3).
 *
 * Un `ip http server` qui écoute sans rien servir serait le défaut qu'on
 * vient de refermer sous une autre forme : un port ouvert que rien ne
 * lit. Ce que sert le vrai serveur d'IOS, c'est l'EXEC — l'URL
 * `/level/<n>/exec/<commande>` exécute la commande au niveau demandé et
 * rend sa sortie. C'est la porte qui a rendu célèbre la faille
 * d'autorisation de 2001, et c'est surtout la seule chose qui fasse de
 * cette commande autre chose qu'un drapeau.
 *
 * La sortie n'est pas inventée : la coquille HTML, l'en-tête `Server`,
 * l'en-tête `Expires` et le corps du 401 sont repris d'une transcription
 * RÉELLE d'un IOS (module Metasploit `ios_http_auth_bypass`, qui cite le
 * dialogue `nc` complet vers une machine 11.3) — un module d'exploitation
 * doit reproduire ce que la machine accepte, donc il constitue une
 * référence et non un exemple.
 *
 * **La porte lit le MÊME shell que la console.** `runExec` reçoit le
 * `createVtyShell` du routeur : `show version` par HTTP rend le texte de
 * `show version`, pas un second rendu. Deux réponses possibles à une
 * seule question est le défaut que ce dépôt referme partout ailleurs.
 */
import type { HttpMessage } from '@/network/http/semantics/types';
import { createResponse } from '@/network/http/semantics/types';
import type { HttpAuthMethod } from './CiscoHttpService';

export interface CiscoHttpUiContext {
  readonly hostname: () => string;
  /** Lue à chaque requête : `ip http authentication` peut changer entre deux. */
  readonly authMethod: () => HttpAuthMethod;
  /** Niveau de privilège du compte, ou null si le compte n'existe pas. */
  readonly authenticate: (
    method: HttpAuthMethod, user: string, password: string,
  ) => Promise<{ ok: boolean; privilege: number }>;
  /** Exécute une commande exec au niveau demandé et rend sa sortie. */
  readonly runExec: (command: string, level: number, user: string) => Promise<string>;
  /** `ip http access-class` — false ⇒ la connexion n'est pas servie. */
  readonly permitted: (sourceIp: string) => boolean;
}

/** `Expires:` d'IOS — une date fixe dans le passé, comme sur la machine réelle. */
const EXPIRES = 'Thu, 16 Feb 1989 00:00:00 GMT';
const SERVER = 'cisco-IOS/15.7 HTTP-server/1.0';

/**
 * Le niveau demandé par l'URL. IOS accepte `/level/<n>/exec/...` et la
 * forme courte `/exec/...`, qui prend le niveau du compte.
 */
interface ExecTarget {
  readonly level: number | null;
  readonly command: string;
}

export class CiscoHttpUi {
  constructor(private readonly ctx: CiscoHttpUiContext) {}

  async handle(request: HttpMessage, peerIp: string): Promise<HttpMessage> {
    if (!this.ctx.permitted(peerIp)) {
      // Refusé par l'access-class : IOS ferme sans rien servir. Un 403
      // décrirait une décision applicative, alors que le refus est celui
      // du serveur avant toute lecture de la requête.
      return this.plain(403, 'Forbidden', 'Access denied');
    }

    const target = parseTarget(request.target ?? '/');
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      const res = this.plain(405, 'Method Not Allowed', 'Method not allowed');
      res.headers.set('Allow', 'GET, HEAD, POST');
      return res;
    }

    const wanted = target?.level ?? 15;
    const credentials = parseBasic(request.headers.get('Authorization'));
    if (!credentials) return this.unauthorized(wanted);

    const verdict = await this.ctx.authenticate(
      this.ctx.authMethod(), credentials.user, credentials.password);
    if (!verdict.ok) return this.unauthorized(wanted);

    // Le niveau du compte plafonne ce que l'URL peut demander : c'est
    // exactement le contrôle dont l'absence faisait la faille de 2001,
    // où `/level/16/` et au-delà contournaient l'authentification.
    if (target?.level !== null && target !== null && verdict.privilege < target.level) {
      return this.unauthorized(target.level);
    }

    if (target === null) return this.home(verdict.privilege);

    const level = target.level ?? verdict.privilege;
    const output = await this.ctx.runExec(target.command, level, credentials.user);
    return this.execPage(target.command, level, output);
  }

  /**
   * Le 401 d'IOS, corps compris. Le domaine (`realm`) NOMME le niveau
   * demandé — c'est ce qui apprend à l'opérateur quel privilège lui
   * manque, et un domaine constant le lui cacherait.
   */
  private unauthorized(level: number): HttpMessage {
    const res = createResponse(401, 'Unauthorized');
    res.headers.set('Server', SERVER);
    res.headers.set('Content-Type', 'text/html');
    res.headers.set('Expires', EXPIRES);
    res.headers.set('WWW-Authenticate', `Basic realm="level_${level}_access"`);
    setBody(res, '<HEAD><TITLE>Authorization Required</TITLE></HEAD><BODY>'
      + '<H1>Authorization Required</H1>Browser not authentication-capable '
      + 'or authentication failed.</BODY>');
    return res;
  }

  private home(privilege: number): HttpMessage {
    const host = this.ctx.hostname();
    const body = `<HTML><HEAD><TITLE>${host} Home Page</TITLE></HEAD>\n`
      + `<BODY><H1>Cisco Systems</H1><H2>Accessing Cisco ${host}</H2>\n`
      + `<A HREF="/level/${privilege}/exec/-">Show interfaces, routes and more</A>\n`
      + '</BODY></HTML>';
    return this.html(body);
  }

  /**
   * La page d'une commande exécutée, dans la coquille de la machine
   * réelle — titre, `<H1>` du nom d'hôte, `<PRE>` puis la sortie brute.
   */
  private execPage(command: string, level: number, output: string): HttpMessage {
    const host = this.ctx.hostname();
    const path = `/level/${level}/exec/${command}`;
    const body = `<HTML><HEAD><TITLE>${host} ${path}</TITLE></HEAD>\n`
      + `<BODY><H1>${host}</H1><PRE><HR>\n`
      + `<FORM METHOD=POST ACTION="${path}"><DL>\n`
      + `${escapeHtml(output)}\n`
      + '</DL></FORM></PRE></BODY></HTML>';
    return this.html(body);
  }

  private html(body: string): HttpMessage {
    const res = createResponse(200, 'OK');
    res.headers.set('Server', SERVER);
    res.headers.set('Content-Type', 'text/html');
    res.headers.set('Expires', EXPIRES);
    setBody(res, body);
    return res;
  }

  private plain(status: number, reason: string, text: string): HttpMessage {
    const res = createResponse(status, reason);
    res.headers.set('Server', SERVER);
    res.headers.set('Content-Type', 'text/html');
    setBody(res, text);
    return res;
  }
}

/**
 * Le corps d'un message HTTP est fait d'OCTETS ici, et `Content-Length`
 * les compte : poser la longueur de la chaîne donnerait un compte faux
 * dès qu'un nom d'hôte ou une sortie porte un caractère non ASCII, et le
 * pair attendrait des octets qui ne viendraient jamais.
 */
function setBody(message: HttpMessage, text: string): void {
  const bytes = new TextEncoder().encode(text);
  message.body = bytes;
  message.headers.set('Content-Length', String(bytes.length));
}

/**
 * `/level/15/exec/show/version` et `/level/15/exec/show%20version` sont
 * la MÊME requête : IOS accepte la commande découpée en segments d'URL
 * comme il l'accepte échappée, et un navigateur produit tantôt l'une
 * tantôt l'autre. Rendre `null` signifie « la racine », pas « invalide ».
 */
export function parseTarget(target: string): ExecTarget | null {
  const path = decodeURIComponent(target.split('?')[0] ?? '/');
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  let level: number | null = null;
  let i = 0;
  if (parts[0].toLowerCase() === 'level') {
    const n = Number(parts[1]);
    if (!Number.isInteger(n) || n < 0 || n > 15) return null;
    level = n;
    i = 2;
  }
  if (parts[i]?.toLowerCase() !== 'exec') return null;
  const command = parts.slice(i + 1).join(' ').trim();
  return { level, command: command === '-' ? 'show version' : command };
}

function parseBasic(header: string | undefined): { user: string; password: string } | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeBase64(match[1].trim());
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeBase64(text: string): string {
  const clean = text.replace(/=+$/, '');
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
