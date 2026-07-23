---
name: serve-public
description: Expose a local port as a public HTTPS subdomain under IRIS_BASE_DOMAIN. Writes nginx config, obtains SSL cert via certbot, reloads nginx.
---

# Skill: serve-public

Expose a service (running in Docker or on host) as a public HTTPS subdomain.

Given a subdomain name and a host port, this skill:
1. Writes an nginx reverse-proxy config for `<name>.<IRIS_BASE_DOMAIN>`
2. Enables the site
3. Obtains/renews an SSL cert via certbot
4. Reloads nginx

The wildcard DNS `*.<IRIS_BASE_DOMAIN>` is already configured during bootstrap — no DNS step needed here.

## Usage

```bash
serve-public <name> <host-port>
```

- `name` — subdomain prefix, e.g. `weather` → `weather.${IRIS_BASE_DOMAIN}`
- `host-port` — port on the host that the service listens on

## Examples

```bash
# Expose weather web UI (container port mapped to host :8080)
serve-public weather 8080

# Expose a different agent
serve-public digest 8090
```

## Implementation

```bash
#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?Usage: serve-public <name> <host-port>}"
PORT="${2:?Usage: serve-public <name> <host-port>}"

BASE_DOMAIN="${IRIS_BASE_DOMAIN:?IRIS_BASE_DOMAIN not set — configure in /iris/.env}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@${BASE_DOMAIN#*.}}"
FQDN="${NAME}.${BASE_DOMAIN}"
CONF="/etc/nginx/sites-available/${FQDN}"

echo "[serve-public] Exposing http://localhost:${PORT} as https://${FQDN}"

# 1. Write nginx config (HTTP only — certbot will add HTTPS block)
sudo tee "$CONF" > /dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN};

    location / {
        proxy_pass         http://localhost:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
NGINX

# 2. Enable site
sudo ln -sfn "$CONF" "/etc/nginx/sites-enabled/${FQDN}"

# 3. Reload nginx (HTTP must be up for certbot HTTP-01 challenge)
sudo nginx -t
sudo systemctl reload nginx

# 4. Obtain/renew SSL cert
sudo certbot --nginx \
    -d "$FQDN" \
    --non-interactive \
    --agree-tos \
    -m "$CERTBOT_EMAIL" \
    --redirect

echo "[serve-public] Done — https://${FQDN} is live"
```

## Notes

- Requires nginx and certbot installed (bootstrap.sh handles this)
- Requires port 80/443 open on NSG (bootstrap.sh handles this — Azure only; on other clouds, e.g. Oracle Cloud's default images with OS-level `iptables` rules, open 80/443 in both the cloud console and the VM's own firewall manually — see [Troubleshooting](../../docs/troubleshooting.md))
- Wildcard DNS `*.<IRIS_BASE_DOMAIN>` must already point to this VM (bootstrap.sh handles this)
- Re-running with the same name is safe — updates the port and renews the cert if needed
- For WebSocket support, the config includes `Upgrade` and `Connection` headers
- To remove a service: `sudo rm /etc/nginx/sites-{available,enabled}/<fqdn> && sudo systemctl reload nginx`
