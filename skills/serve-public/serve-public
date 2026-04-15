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
