export const NGINX_CONF_PATH = '/etc/nginx/nginx.conf';
export const NGINX_SITES_AVAILABLE = '/etc/nginx/sites-available';
export const NGINX_SITES_ENABLED = '/etc/nginx/sites-enabled';
export const NGINX_DEFAULT_ROOT = '/var/www/html';
export const NGINX_DEFAULT_INDEX = 'index.nginx-debian.html';
export const NGINX_ACCESS_LOG = '/var/log/nginx/access.log';
export const NGINX_ERROR_LOG = '/var/log/nginx/error.log';
export const NGINX_BINARY = '/usr/sbin/nginx';
export const NGINX_VERSION = '1.24.0';

export const NGINX_CONF = `user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
	worker_connections 768;
}

http {
	sendfile on;
	tcp_nopush on;
	types_hash_max_size 2048;

	include /etc/nginx/mime.types;
	default_type application/octet-stream;

	access_log /var/log/nginx/access.log;

	gzip on;

	include /etc/nginx/conf.d/*.conf;
	include /etc/nginx/sites-enabled/*;
}
`;

export const NGINX_DEFAULT_SITE = `server {
	listen 80 default_server;
	listen [::]:80 default_server;

	root /var/www/html;

	index index.nginx-debian.html index.html index.htm;

	server_name _;

	location / {
		try_files $uri $uri/ =404;
	}
}
`;

export const NGINX_WELCOME_PAGE = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;

export function notFoundPage(): string {
  return `<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/${NGINX_VERSION}</center>\r\n</body>\r\n</html>\r\n`;
}

export function forbiddenPage(): string {
  return `<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n<hr><center>nginx/${NGINX_VERSION}</center>\r\n</body>\r\n</html>\r\n`;
}

/**
 * §P6 — la page qu'un vrai nginx sert quand l'amont ne répond pas.
 * Elle ne dit PAS pourquoi, exactement comme la vraie : la raison va
 * dans `error.log`, et c'est là que l'opérateur apprend à la chercher.
 */
export function badGatewayPage(): string {
  return `<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/${NGINX_VERSION}</center>\r\n</body>\r\n</html>\r\n`;
}
