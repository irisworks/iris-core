#!/usr/bin/env bash
# ============================================================
# Iris Bootstrap Script
# Run this on a fresh Azure VM to bring Iris fully back online.
# Everything is restored from GitHub + Azure Key Vault.
#
# Usage:
#   cd /home/azureuser/dev/iris-core
#   KV_NAME=<key-vault-name> bash bootstrap.sh
#
# Or, from outside the repo:
#   REPO_DIR=/path/to/iris-core KV_NAME=<key-vault-name> bash /path/to/iris-core/bootstrap.sh
# ============================================================
set -euo pipefail

IRIS_DIR="/iris"

# NOTE: Set REPO_URL if not running from within a git repo
# Example: REPO_URL=https://github.com/your-org/iris-core.git
REPO_URL="${REPO_URL:-}"
KV_NAME="${KV_NAME:-}"
KV_RESOURCE_GROUP="${KV_RESOURCE_GROUP:-}"
REPO_DIR="${REPO_DIR:-}"

# iris-runtime: our fork of pi-mom, provider-agnostic
# Model/provider: env vars override defaults
IRIS_PROVIDER="${IRIS_PROVIDER:-foundry-e2}"
IRIS_MODEL="${IRIS_MODEL:-Kimi-K2.5}"
IRIS_ENV="${IRIS_ENV:-prod}"

# Public web serving — set IRIS_BASE_DOMAIN to enable (e.g. ${IRIS_BASE_DOMAIN})
IRIS_BASE_DOMAIN="${IRIS_BASE_DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"      # defaults to admin@<parent-zone> if not set

log() { echo "[iris-bootstrap] $*"; }
die() { echo "[iris-bootstrap] ERROR: $*" >&2; exit 1; }

resolve_repo_dir() {
  if [[ -n "$REPO_DIR" ]]; then
    return
  fi
  REPO_DIR="${IRIS_DIR}/repo"
}

docker_cmd() {
  if docker info &>/dev/null; then
    docker "$@"
  else
    sudo docker "$@"
  fi
}

# ────────────────────────────────────────────────────────────
# 1. System dependencies
# ────────────────────────────────────────────────────────────
log "Installing system dependencies..."

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq

# Docker
if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo bash
  sudo usermod -aG docker "$USER"
  log "Docker installed. NOTE: You may need to re-login for group membership to take effect."
fi

# Azure CLI
if ! command -v az &>/dev/null; then
  log "Installing Azure CLI..."
  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
fi

# GitHub CLI
if ! command -v gh &>/dev/null; then
  log "Installing GitHub CLI..."
  sudo apt-get install -y gh
fi

# Terraform
if ! command -v terraform &>/dev/null; then
  log "Installing Terraform..."
  wget -qO- https://apt.releases.hashicorp.com/gpg \
    | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
    | sudo tee /etc/apt/sources.list.d/hashicorp.list
  sudo apt-get update -qq && sudo apt-get install -y terraform
fi

# jq
if ! command -v jq &>/dev/null; then
  sudo apt-get install -y jq
fi

# nginx + certbot (needed for public web serving)
if ! command -v nginx &>/dev/null; then
  log "Installing nginx..."
  sudo apt-get install -y nginx
  sudo systemctl enable nginx
fi

if ! command -v certbot &>/dev/null; then
  log "Installing certbot..."
  sudo apt-get install -y certbot python3-certbot-nginx
fi

# iris-git wrapper — commits as Iris without touching global/repo git config
if ! command -v iris-git &>/dev/null; then
  log "Installing iris-git wrapper..."
  sudo tee /usr/local/bin/iris-git > /dev/null << 'SCRIPT'
#!/usr/bin/env bash
exec git \
  -c user.name="Iris" \
  -c user.email="${GIT_USER_EMAIL:-iris@example.com}" \
  "$@"
SCRIPT
  sudo chmod +x /usr/local/bin/iris-git
fi

# Node.js (needed to build and run iris-runtime)
if ! command -v node &>/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# ────────────────────────────────────────────────────────────
# 2. Azure login
# ────────────────────────────────────────────────────────────
log "Checking Azure login..."
if ! az account show &>/dev/null; then
  log "Not logged in. Running az login..."
  az login
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
log "Using subscription: $SUBSCRIPTION_ID"

# ────────────────────────────────────────────────────────────
# DNS + NSG — public networking setup (only if IRIS_BASE_DOMAIN set)
# ────────────────────────────────────────────────────────────
if [[ -n "$IRIS_BASE_DOMAIN" ]]; then
  log "Setting up public networking for $IRIS_BASE_DOMAIN..."

  # Discover VM identity from instance metadata
  VM_NAME=$(curl -sf -H Metadata:true \
    "http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text" || echo "")
  VM_RG=$(curl -sf -H Metadata:true \
    "http://169.254.169.254/metadata/instance/compute/resourceGroupName?api-version=2021-02-01&format=text" || echo "")

  if [[ -z "$VM_NAME" || -z "$VM_RG" ]]; then
    log "Warning: Could not detect VM metadata — skipping DNS/NSG setup"
  else
    # Get VM public IP
    PUBLIC_IP=$(az network public-ip list -g "$VM_RG" \
      --query "[0].ipAddress" -o tsv 2>/dev/null || echo "")

    if [[ -z "$PUBLIC_IP" ]]; then
      log "Warning: No public IP found for VM in $VM_RG — skipping DNS/NSG setup"
    else
      log "VM: $VM_NAME ($VM_RG) — public IP: $PUBLIC_IP"

      # Derive parent zone and subdomain prefix from IRIS_BASE_DOMAIN
      # e.g. ${IRIS_BASE_DOMAIN}  →  PARENT_ZONE=example.com  PREFIX=iris
      PARENT_ZONE=$(echo "$IRIS_BASE_DOMAIN" | sed 's/^[^.]*\.//')
      DNS_PREFIX=$(echo "$IRIS_BASE_DOMAIN" | cut -d. -f1)

      # Auto-detect DNS zone resource group
      DNS_ZONE_RG=$(az network dns zone list \
        --query "[?name=='$PARENT_ZONE'].resourceGroup | [0]" -o tsv 2>/dev/null || echo "")

      if [[ -z "$DNS_ZONE_RG" ]]; then
        log "Warning: DNS zone '$PARENT_ZONE' not found in subscription — set DNS records manually"
      else
        log "DNS zone: $PARENT_ZONE (rg: $DNS_ZONE_RG)"

        # A record: ${IRIS_BASE_DOMAIN} → PUBLIC_IP  (idempotent)
        az network dns record-set a create \
          --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
          -n "$DNS_PREFIX" --ttl 300 2>/dev/null || true
        # Remove stale IPs, add current
        az network dns record-set a remove-record \
          --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
          -n "$DNS_PREFIX" --ipv4-address "$PUBLIC_IP" 2>/dev/null || true
        az network dns record-set a add-record \
          --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
          -n "$DNS_PREFIX" --ipv4-address "$PUBLIC_IP" 2>/dev/null
        log "DNS: $IRIS_BASE_DOMAIN → $PUBLIC_IP"

        # Wildcard A record: *.${IRIS_BASE_DOMAIN} → PUBLIC_IP  (idempotent)
        WILDCARD="*.$DNS_PREFIX"
        az network dns record-set a create \
          --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
          -n "$WILDCARD" --ttl 300 2>/dev/null || true
        az network dns record-set a remove-record \
          --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
          -n "$WILDCARD" --ipv4-address "$PUBLIC_IP" 2>/dev/null || true
        az network dns record-set a add-record \
          --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
          -n "$WILDCARD" --ipv4-address "$PUBLIC_IP" 2>/dev/null
        log "DNS: *.$IRIS_BASE_DOMAIN → $PUBLIC_IP"
      fi

      # Open ports 80 and 443 on the VM's NSG (idempotent)
      NSG_NAME=$(az network nsg list -g "$VM_RG" \
        --query "[0].name" -o tsv 2>/dev/null || echo "")
      if [[ -n "$NSG_NAME" ]]; then
        for RULE in "AllowHTTP:80:100" "AllowHTTPS:443:101"; do
          RNAME=$(echo "$RULE" | cut -d: -f1)
          RPORT=$(echo "$RULE" | cut -d: -f2)
          RPRIO=$(echo "$RULE" | cut -d: -f3)
          EXISTING=$(az network nsg rule show --nsg-name "$NSG_NAME" \
            -g "$VM_RG" -n "$RNAME" 2>/dev/null || echo "")
          if [[ -z "$EXISTING" ]]; then
            az network nsg rule create \
              --nsg-name "$NSG_NAME" -g "$VM_RG" \
              -n "$RNAME" --priority "$RPRIO" \
              --destination-port-ranges "$RPORT" \
              --access Allow --protocol Tcp --direction Inbound 2>/dev/null
            log "NSG: opened port $RPORT ($RNAME)"
          else
            log "NSG: port $RPORT already open"
          fi
        done
      fi
    fi
  fi

  # Default certbot email
  if [[ -z "$CERTBOT_EMAIL" ]]; then
    CERTBOT_EMAIL="admin@${PARENT_ZONE:-$IRIS_BASE_DOMAIN}"
  fi

  # Base nginx config — catch-all 404 for unconfigured subdomains
  log "Writing base nginx config..."
  sudo tee /etc/nginx/sites-available/iris-default > /dev/null <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 404;
}
NGINX
  sudo ln -sfn /etc/nginx/sites-available/iris-default \
    /etc/nginx/sites-enabled/iris-default
  # Remove stock default site
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t 2>/dev/null && sudo systemctl reload nginx
  log "nginx ready"
fi

# ────────────────────────────────────────────────────────────
# 3. Discover Key Vault (created by Terraform)
# ────────────────────────────────────────────────────────────
if [[ -n "$KV_NAME" ]]; then
  log "Using Key Vault from KV_NAME: $KV_NAME"
else
  [[ -z "$KV_RESOURCE_GROUP" ]] && die "Set KV_NAME or KV_RESOURCE_GROUP before running bootstrap."
  log "Looking up Iris Key Vault in resource group '$KV_RESOURCE_GROUP'..."
  KV_NAME=$(az keyvault list \
    --resource-group "$KV_RESOURCE_GROUP" \
    --query "[?tags.\"iris-component\"=='keyvault'].name | [0]" \
    -o tsv 2>/dev/null || true)
fi

if [[ -z "$KV_NAME" ]]; then
  die "Key Vault not found. Set KV_NAME explicitly or set KV_RESOURCE_GROUP to the resource group that contains the Iris Key Vault."
fi
log "Key Vault: $KV_NAME"

# ────────────────────────────────────────────────────────────
# 4. Fetch secrets from Key Vault
# ────────────────────────────────────────────────────────────
log "Fetching secrets from Key Vault..."

fetch_secret() {
  local name="$1"
  az keyvault secret show --vault-name "$KV_NAME" --name "$name" --query value -o tsv 2>/dev/null || true
}

ANTHROPIC_API_KEY=$(fetch_secret "ANTHROPIC-API-KEY")
OPENAI_API_KEY=$(fetch_secret "OPENAI-API-KEY")
GITHUB_TOKEN=$(fetch_secret "GITHUB-TOKEN")
SLACK_APP_TOKEN=$(fetch_secret "SLACK-APP-TOKEN")
SLACK_BOT_TOKEN=$(fetch_secret "SLACK-BOT-TOKEN")

# Azure AI Foundry — primary LLM source (no Anthropic key required if Foundry is configured)
FOUNDRY_E2_KEY=$(fetch_secret "FOUNDRY-E2-KEY")

# Validate required secrets (Slack always required; LLM: Anthropic OR Foundry)
if [[ -z "$ANTHROPIC_API_KEY" && -z "$FOUNDRY_E2_KEY" ]]; then
  die "No LLM API key found. Store either ANTHROPIC-API-KEY or FOUNDRY-E2-KEY in Key Vault '$KV_NAME'."
fi
[[ -z "$SLACK_APP_TOKEN" ]] && die "Secret SLACK-APP-TOKEN not found in Key Vault '$KV_NAME'. Store it first."
[[ -z "$SLACK_BOT_TOKEN" ]] && die "Secret SLACK-BOT-TOKEN not found in Key Vault '$KV_NAME'. Store it first."

# ────────────────────────────────────────────────────────────
# 5. Set up Iris workspace
# ────────────────────────────────────────────────────────────
resolve_repo_dir

log "Setting up workspace at $IRIS_DIR..."
sudo mkdir -p "$IRIS_DIR"
sudo chown "$USER:$USER" "$IRIS_DIR"

if [[ "$REPO_DIR" == "${IRIS_DIR}/repo" ]]; then
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    log "Cloning iris-core repo into $REPO_DIR..."
    git clone "$REPO_URL" "$REPO_DIR"
  else
    log "Updating repo at $REPO_DIR..."
    git -C "$REPO_DIR" pull --ff-only
  fi
else
  [[ -d "$REPO_DIR/.git" ]] || die "REPO_DIR '$REPO_DIR' is not a git checkout."
  log "Using local repo at $REPO_DIR"
  ln -sfn "$REPO_DIR" "$IRIS_DIR/repo"
fi

# Set up data directory (pi-mom workspace)
mkdir -p "$IRIS_DIR/data"

# Symlinks: data/ points to repo assets so changes hot-reload without restart
# MEMORY.md   = Iris's mutable global memory (she can append, we can edit via repo)
# CONSTITUTION.md = operator rules (read-only from Iris's perspective; lives in repo)
ln -sfn "$REPO_DIR/MEMORY.md"        "$IRIS_DIR/data/MEMORY.md"
ln -sfn "$REPO_DIR/CONSTITUTION.md"  "$IRIS_DIR/data/CONSTITUTION.md"
ln -sfn "$REPO_DIR/skills"           "$IRIS_DIR/data/skills"

# Copy models.json to data dir (not a symlink — it's runtime config, not hot-reloaded)
cp "$REPO_DIR/data/models.json" "$IRIS_DIR/data/models.json"

# Write .env for iris-runtime (sourced by systemd service)
log "Writing .env..."
cat > "$IRIS_DIR/.env" <<ENV
# LLM provider selection — iris-runtime reads these
IRIS_PROVIDER=${IRIS_PROVIDER}
IRIS_MODEL=${IRIS_MODEL}
IRIS_ENV=${IRIS_ENV}

# Azure AI Foundry API keys — consumed by data/models.json apiKey field
FOUNDRY_E2_KEY=${FOUNDRY_E2_KEY:-}

# Anthropic fallback (optional — only needed if IRIS_PROVIDER=anthropic)
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}

# Slack
IRIS_SLACK_APP_TOKEN=${SLACK_APP_TOKEN}
IRIS_SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}

# GitHub
GITHUB_TOKEN=${GITHUB_TOKEN:-}

# Azure infra
AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}
IRIS_KEY_VAULT=${KV_NAME}
IRIS_REPO_DIR=${REPO_DIR}
IRIS_STORAGE_ROOT=${IRIS_DIR}/data

# Public web serving
IRIS_BASE_DOMAIN=${IRIS_BASE_DOMAIN:-}
CERTBOT_EMAIL=${CERTBOT_EMAIL:-}
ENV
chmod 600 "$IRIS_DIR/.env"

# ────────────────────────────────────────────────���───────────
# 6. Iris runs on the host — no sandbox container needed
# Docker is available on the host for sub-agent containers (spawn-agent skill).
# ────────────────────────────────────────────────────────────
log "Skipping sandbox container — Iris runs bash directly on host."

# ────────────────────────────────────────────────────────────
# 7. Build iris-runtime from source
# ────────────────────────────────────────────────────────────
log "Building iris-runtime..."
RUNTIME_DIR="$REPO_DIR/iris-runtime"
cd "$RUNTIME_DIR"
npm install --prefer-offline 2>&1 | tail -3
npm run build 2>&1 | tail -5
cd -

# ────────────────────────────────────────────────────────────
# 8. Install systemd service (persist across reboots)
# ────────────────────────────────────────────────────────────
log "Installing systemd service..."
NODE_BIN="$(which node)"
IRIS_RUNTIME_BIN="$REPO_DIR/iris-runtime/dist/main.js"

sudo tee /etc/systemd/system/iris.service > /dev/null <<UNIT
[Unit]
Description=Iris Meta-Agent (iris-runtime)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${IRIS_DIR}
EnvironmentFile=${IRIS_DIR}/.env
ExecStart=${NODE_BIN} ${IRIS_RUNTIME_BIN} --sandbox=host ${IRIS_DIR}/data
Restart=always
RestartSec=10
StandardOutput=append:${IRIS_DIR}/iris-runtime.log
StandardError=append:${IRIS_DIR}/iris-runtime.log
SyslogIdentifier=iris

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable iris
sudo systemctl restart iris
sleep 2
if ! sudo systemctl is-active --quiet iris; then
  sudo journalctl -u iris -n 100 --no-pager || true
  die "iris.service failed to start cleanly."
fi

# ────────────────────────────────────────────────────────────
# 9. Done
# ────────────────────────────────────────────────────────────
log "Bootstrap complete."
log ""
log "  Iris is running: journalctl -u iris -f"
log "  Status:          sudo systemctl status iris"
log "  Slack:           @iris in any channel"
log "  Provider:        ${IRIS_PROVIDER}/${IRIS_MODEL}"
log ""
log "  Key Vault:  $KV_NAME"
log "  Workspace:  $IRIS_DIR"
log "  Repo:       $REPO_DIR"
log "  Runtime:    $REPO_DIR/iris-runtime"
