/**
 * PRD-HTTP.md §2.1.K — "redirection HTTP→HTTPS optionnelle côté serveur":
 * a plain HTTP/1.1 request handler (`Http1ServerSession`'s
 * `Http1RequestHandler`, RFC 9112) that always answers with a redirect to
 * the HTTPS equivalent of the requested target, per RFC 9110 §15.4.9 (308,
 * preserves the request method/body — appropriate here since the resource
 * itself hasn't moved, only the scheme has).
 */
import { createResponse, type HttpMessage } from '../semantics/types';
import type { Http1RequestHandler } from '../http1/Http1ServerSession';

export function createHttpToHttpsRedirectHandler(host: string, httpsPort = 443): Http1RequestHandler {
  const authority = httpsPort === 443 ? host : `${host}:${httpsPort}`;
  return (request: HttpMessage): HttpMessage => {
    const response = createResponse(308, 'Permanent Redirect', request.httpVersion);
    response.headers.set('Location', `https://${authority}${request.target ?? '/'}`);
    response.headers.set('Content-Length', '0');
    return response;
  };
}
