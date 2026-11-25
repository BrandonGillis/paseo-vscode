# Remote access

By default VS Code only opens when the Paseo app runs on the daemon host. This page explains why, and how to open it from another machine through a reverse proxy.

## Why it is local by default

code-server listens on a Unix socket that only your user can open. A small proxy inside the plugin puts it on `http://127.0.0.1:<port>/<secret>/`, and the VS Code tab is an iframe on that URL.

The iframe is loaded by the Paseo app, not by the daemon. When the app runs on another machine (a remote daemon, a server reached through the Paseo relay), `127.0.0.1` is that other machine, nothing listens there, and the tab stays empty.

## Settings

**Settings → Plugins → VS Code → Remote access** has three settings. Changes apply the next time VS Code starts: reload the plugin with `paseo plugin reload paseo-vscode`.

| Setting | Default | Meaning |
| --- | --- | --- |
| Listen address | `127.0.0.1` | Address the proxy listens on. Use an address your reverse proxy can reach: the host's LAN address, or `0.0.0.0`. |
| Port | `0` | Fixed port for the local VS Code proxy, so the reverse proxy has a stable target. `0` keeps the automatic port (reused across restarts when free). With a fixed port, VS Code fails to start instead of silently moving to another port when it is taken. |
| Public URL | empty | URL the browser opens instead of `http://127.0.0.1:<port>`. `{port}` is replaced by the proxy's port. Empty keeps `http://127.0.0.1:<port>`. |

The plugin still appends `/<secret>/` to the public URL. The Paseo Bridge extension keeps talking to the proxy directly on the daemon host (`127.0.0.1`, or the listen address when it is a specific one).

The settings are stored in `~/.paseo/plugin-settings/paseo-vscode/settings.json`:

```json
{
  "version": 1,
  "values": {
    "extensions": [],
    "listenHost": "192.168.1.10",
    "port": 33195,
    "publicUrl": "https://vscode.example.com"
  }
}
```

## Use HTTPS

Serve the public URL over HTTPS with a certificate your browser trusts. On a plain `http://` address that is not `localhost`, browsers do not treat the page as a secure context, and VS Code's webviews, service workers and clipboard break. A self-signed certificate does not work either: the browser refuses it inside the iframe without asking.

## nginx example

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name vscode.example.com;
    # ssl_certificate     /path/to/fullchain.pem;
    # ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://192.168.1.10:33195;
        proxy_http_version 1.1;
        # code-server compares the WebSocket Origin with Host: keep the public host.
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
        proxy_buffering off;
        client_max_body_size 0;
    }
}
```

With Nginx Proxy Manager, create a proxy host for `192.168.1.10:33195` with **Websockets Support** on and an SSL certificate.

Do not add `X-Frame-Options` or a `Content-Security-Policy` with `frame-ancestors` on this host: VS Code is shown in an iframe of the Paseo app.

## Dev containers

Each dev container gets its own proxy and port; the port is kept in `~/.paseo/plugin-data/paseo-vscode/containers/*.port`. To reach them, put `{port}` in the public URL, for example `https://vscode.example.com/{port}`, and route each port in the reverse proxy:

```nginx
location /33195/ {
    proxy_pass http://192.168.1.10:33195/;   # the trailing slash strips /33195
    # same proxy_* lines as above
}
```

The Port setting only fixes the local VS Code port. Container ports are chosen automatically and kept across restarts when free.

## Security

code-server runs with `--auth none`. On `127.0.0.1` the only way in is the per-start secret in the URL, which Paseo receives over its own connection. With remote access, anyone who can reach the listen address or the public URL and knows the secret can use VS Code, including its terminal, as your user.

- Make the listen address reachable only from the reverse proxy (firewall).
- Serve the public URL over HTTPS only, so the secret is not sent in clear text.
- Consider restricting the public URL further (VPN, IP allow list) when nothing else needs it.
