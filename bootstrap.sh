#!/usr/bin/env bash
# ============================================================
# Iris Bootstrap Script
#
# Two modes:
#
#   First-time setup (interactive):
#     bash bootstrap.sh --setup
#
#   Restore / re-deploy (Key Vault + secrets already exist):
#     KV_NAME=<vault> bash bootstrap.sh
#
# All config can be passed via env vars to skip prompts.
# ============================================================
set -euo pipefail

IRIS_DIR="/iris"
REPO_URL="${REPO_URL:-}"
KV_NAME="${KV_NAME:-}"
KV_RESOURCE_GROUP="${KV_RESOURCE_GROUP:-}"
REPO_DIR="${REPO_DIR:-}"
SETUP_MODE=false

IRIS_PROVIDER="${IRIS_PROVIDER:-}"
IRIS_MODEL="${IRIS_MODEL:-}"
IRIS_ENV="${IRIS_ENV:-prod}"
IRIS_BASE_DOMAIN="${IRIS_BASE_DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-}"

log()     { echo "[iris-bootstrap] $*"; }
log_h()   { echo ""; echo "[iris-bootstrap] ── $* ──"; }
die()     { echo "[iris-bootstrap] ERROR: $*" >&2; exit 1; }
confirm() {
  # confirm "Question" default(y/n) → returns 0 for yes, 1 for no
  local prompt="$1" default="${2:-y}"
  local yn_hint; [[ "$default" == "y" ]] && yn_hint="[Y/n]" || yn_hint="[y/N]"
  read -r -p "[iris-bootstrap] $prompt $yn_hint " answer
  answer="${answer:-$default}"
  [[ "${answer,,}" == "y" ]]
}
prompt() {
  # prompt "Question" [default] → prints answer to stdout
  local question="$1" default="${2:-}"
  local hint; [[ -n "$default" ]] && hint=" [$default]" || hint=""
  read -r -p "[iris-bootstrap] $question$hint: " answer
  echo "${answer:-$default}"
}
prompt_secret() {
  local question="$1"
  read -r -s -p "[iris-bootstrap] $question: " answer
  echo ""  # newline after silent input
  echo "$answer"
}

# ────────────────────────────────────────────────────────────
# Parse args
# ────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --setup) SETUP_MODE=true ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

docker_cmd() {
  if docker info &>/dev/null; then docker "$@"; else sudo docker "$@"; fi
}

resolve_repo_dir() {
  if [[ -n "$REPO_DIR" ]]; then return; fi
  REPO_DIR="${IRIS_DIR}/repo"
}

# ────────────────────────────────────────────────────────────
# 1. System dependencies
# ────────────────────────────────────────────────────────────
log_h "System dependencies"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq

if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo bash
  sudo usermod -aG docker "$USER"
fi

if ! command -v az &>/dev/null; then
  log "Installing Azure CLI..."
  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
fi

if ! command -v gh &>/dev/null; then
  log "Installing GitHub CLI..."
  sudo apt-get install -y gh
fi

if ! command -v terraform &>/dev/null; then
  log "Installing Terraform..."
  wget -qO- https://apt.releases.hashicorp.com/gpg \
    | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
    | sudo tee /etc/apt/sources.list.d/hashicorp.list
  sudo apt-get update -qq && sudo apt-get install -y terraform
fi

if ! command -v jq &>/dev/null; then sudo apt-get install -y jq; fi

if ! command -v nginx &>/dev/null; then
  log "Installing nginx..."
  sudo apt-get install -y nginx
  sudo systemctl enable nginx
fi

if ! command -v certbot &>/dev/null; then
  log "Installing certbot..."
  sudo apt-get install -y certbot python3-certbot-nginx
fi

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

if ! command -v node &>/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# ────────────────────────────────────────────────────────────
# 2. Azure login
# ────────────────────────────────────────────────────────────
log_h "Azure login"
if ! az account show &>/dev/null; then
  log "Not logged in to Azure. Running az login..."
  az login
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
SUBSCRIPTION_NAME=$(az account show --query name -o tsv)
log "Subscription: $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)"

# ────────────────────────────────────────────────────────────
# 3. GitHub login
# ────────────────────────────────────────────────────────────
log_h "GitHub login"
if ! gh auth status &>/dev/null; then
  log "Not logged in to GitHub. Running gh auth login..."
  gh auth login
fi
GH_USER=$(gh api user --jq .login)
log "GitHub user: $GH_USER"

# ────────────────────────────────────────────────────────────
# 4. --setup mode: interactive first-time configuration
# ────────────────────────────────────────────────────────────
if [[ "$SETUP_MODE" == true ]]; then
  log_h "First-time setup"
  echo ""
  echo "  This will configure Iris for a new deployment."
  echo "  You'll be prompted for provider, API keys, and optional settings."
  echo "  All values are stored in Azure Key Vault — never on disk."
  echo ""

  # ── LLM Provider ──
  if [[ -z "$IRIS_PROVIDER" ]]; then
    echo "[iris-bootstrap] Choose LLM provider:"
    echo "  1) anthropic   — Claude Sonnet / Opus (recommended)"
    echo "  2) openai      — GPT-4o / GPT-4"
    echo "  3) foundry-e2  — Azure AI Foundry (Azure OpenAI)"
    read -r -p "[iris-bootstrap] Choice [1]: " provider_choice
    case "${provider_choice:-1}" in
      1) IRIS_PROVIDER="anthropic" ;;
      2) IRIS_PROVIDER="openai" ;;
      3) IRIS_PROVIDER="foundry-e2" ;;
      *) IRIS_PROVIDER="anthropic" ;;
    esac
  fi

  # ── Model ──
  if [[ -z "$IRIS_MODEL" ]]; then
    case "$IRIS_PROVIDER" in
      anthropic)  default_model="claude-sonnet-4" ;;
      openai)     default_model="gpt-4o" ;;
      foundry-e2) default_model="gpt-4o" ;;
      *)          default_model="gpt-4o" ;;
    esac
    IRIS_MODEL=$(prompt "Model" "$default_model")
  fi
  log "Provider: $IRIS_PROVIDER / $IRIS_MODEL"

  # ── API Key ──
  LLM_API_KEY=""
  FOUNDRY_ACCOUNT=""
  case "$IRIS_PROVIDER" in
    anthropic)
      LLM_API_KEY=$(prompt_secret "Anthropic API key (sk-ant-...)")
      [[ -z "$LLM_API_KEY" ]] && die "Anthropic API key is required."
      ;;
    openai)
      LLM_API_KEY=$(prompt_secret "OpenAI API key (sk-...)")
      [[ -z "$LLM_API_KEY" ]] && die "OpenAI API key is required."
      ;;
    foundry-e2)
      LLM_API_KEY=$(prompt_secret "Azure AI Foundry API key")
      [[ -z "$LLM_API_KEY" ]] && die "Foundry API key is required."
      FOUNDRY_ACCOUNT=$(prompt "Azure AI Foundry account name (e.g. my-account-eastus2)" "")
      [[ -z "$FOUNDRY_ACCOUNT" ]] && die "Foundry account name is required."
      ;;
  esac

  # ── Slack ──
  echo ""
  SLACK_APP_TOKEN=""
  SLACK_BOT_TOKEN=""
  if confirm "Set up Slack integration?"; then
    log "Get tokens from https://api.slack.com/apps"
    SLACK_APP_TOKEN=$(prompt_secret "Slack App token (xapp-...)")
    SLACK_BOT_TOKEN=$(prompt_secret "Slack Bot token (xoxb-...)")
    [[ -z "$SLACK_APP_TOKEN" ]] && die "Slack App token is required."
    [[ -z "$SLACK_BOT_TOKEN" ]] && die "Slack Bot token is required."
  else
    log "Skipping Slack — you can add SLACK-APP-TOKEN / SLACK-BOT-TOKEN to Key Vault later."
  fi

  # ── GitHub token ──
  GITHUB_TOKEN=""
  if confirm "Add GitHub token for repo access?"; then
    GITHUB_TOKEN=$(prompt_secret "GitHub token (ghp_...)")
  fi

  # ── Email (optional) ──
  RESEND_API_KEY=""
  if confirm "Set up email sending (Resend.com)?" "n"; then
    RESEND_API_KEY=$(prompt_secret "Resend API key (re_...)")
  fi

  # ── Domain (optional) ──
  if [[ -z "$IRIS_BASE_DOMAIN" ]]; then
    if confirm "Set up public domain (e.g. iris.example.com)?" "n"; then
      IRIS_BASE_DOMAIN=$(prompt "Base domain" "")
      CERTBOT_EMAIL=$(prompt "Certbot email" "admin@$(echo "$IRIS_BASE_DOMAIN" | sed 's/^[^.]*\.//')")
    fi
  fi

  # ── Git email ──
  if [[ -z "$GIT_USER_EMAIL" ]]; then
    GIT_USER_EMAIL=$(prompt "Git author email for Iris commits" "iris@example.com")
  fi

  # ── Key Vault ──
  echo ""
  log_h "Key Vault setup"

  # Derive a default KV name (max 24 chars, alphanumeric + dashes)
  if [[ -z "$KV_NAME" ]]; then
    # Try to derive from repo directory name or hostname
    suggested="iris-kv-$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-12)"
    KV_NAME=$(prompt "Key Vault name (must be globally unique)" "$suggested")
  fi

  # Derive resource group from VM metadata or prompt
  if [[ -z "$KV_RESOURCE_GROUP" ]]; then
    VM_RG=$(curl -sf -H Metadata:true \
      "http://169.254.169.254/metadata/instance/compute/resourceGroupName?api-version=2021-02-01&format=text" 2>/dev/null || echo "")
    if [[ -n "$VM_RG" ]]; then
      KV_RESOURCE_GROUP=$(prompt "Resource group for Key Vault" "$VM_RG")
    else
      KV_RESOURCE_GROUP=$(prompt "Resource group for Key Vault" "iris-rg")
    fi
  fi

  VM_LOCATION=$(curl -sf -H Metadata:true \
    "http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text" 2>/dev/null || echo "eastus2")

  # Create Key Vault if it doesn't exist
  if az keyvault show --name "$KV_NAME" &>/dev/null 2>&1; then
    log "Key Vault '$KV_NAME' already exists — reusing."
  else
    log "Creating Key Vault '$KV_NAME' in '$KV_RESOURCE_GROUP'..."

    # Ensure resource group exists
    if ! az group show -n "$KV_RESOURCE_GROUP" &>/dev/null 2>&1; then
      log "Creating resource group '$KV_RESOURCE_GROUP' in $VM_LOCATION..."
      az group create -n "$KV_RESOURCE_GROUP" -l "$VM_LOCATION" -o none
    fi

    az keyvault create \
      --name "$KV_NAME" \
      --resource-group "$KV_RESOURCE_GROUP" \
      --location "$VM_LOCATION" \
      --enable-rbac-authorization false \
      --retention-days 7 \
      -o none
    log "✓ Key Vault created: $KV_NAME"
  fi

  # Grant current user access
  CURRENT_USER_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
  if [[ -n "$CURRENT_USER_ID" ]]; then
    az keyvault set-policy \
      --name "$KV_NAME" \
      --object-id "$CURRENT_USER_ID" \
      --secret-permissions get list set delete \
      -o none 2>/dev/null || true
  fi

  # Seed secrets
  log "Seeding secrets into Key Vault..."

  seed_secret() {
    local name="$1" value="$2"
    [[ -z "$value" ]] && return
    az keyvault secret set --vault-name "$KV_NAME" --name "$name" --value "$value" -o none
    log "  ✓ $name"
  }

  case "$IRIS_PROVIDER" in
    anthropic)  seed_secret "ANTHROPIC-API-KEY" "$LLM_API_KEY" ;;
    openai)     seed_secret "OPENAI-API-KEY"    "$LLM_API_KEY" ;;
    foundry-e2) seed_secret "FOUNDRY-E2-KEY"    "$LLM_API_KEY" ;;
  esac

  seed_secret "SLACK-APP-TOKEN" "$SLACK_APP_TOKEN"
  seed_secret "SLACK-BOT-TOKEN" "$SLACK_BOT_TOKEN"
  seed_secret "GITHUB-TOKEN"    "$GITHUB_TOKEN"
  seed_secret "RESEND-API-KEY"  "$RESEND_API_KEY"

  log "✓ Secrets seeded."

  # ── Generate models.json from template ──
  log_h "Generating models.json"
  TEMPLATE="$( cd "$(dirname "$0")" && pwd )/data/models.json.template"

  if [[ "$IRIS_PROVIDER" == "foundry-e2" && -n "$FOUNDRY_ACCOUNT" ]]; then
    # Replace placeholder account name in template
    sed "s|<your-account>|$FOUNDRY_ACCOUNT|g" "$TEMPLATE" > /tmp/iris-models.json
    log "✓ models.json generated for Foundry account: $FOUNDRY_ACCOUNT"
  elif [[ "$IRIS_PROVIDER" == "anthropic" ]]; then
    # Generate a minimal Anthropic models.json
    cat > /tmp/iris-models.json << MODELJSON
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com/v1",
      "api": "anthropic",
      "apiKey": "ANTHROPIC_API_KEY",
      "models": [
        {
          "id": "claude-sonnet-4",
          "name": "Claude Sonnet 4",
          "reasoning": false,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 16000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "claude-opus-4",
          "name": "Claude Opus 4",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "claude-haiku-4-5",
          "name": "Claude Haiku 4.5",
          "reasoning": false,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 8096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
MODELJSON
    log "✓ models.json generated for Anthropic"
  elif [[ "$IRIS_PROVIDER" == "openai" ]]; then
    cat > /tmp/iris-models.json << MODELJSON
{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKey": "OPENAI_API_KEY",
      "models": [
        {
          "id": "gpt-4o",
          "name": "GPT-4o",
          "reasoning": false,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "gpt-4o-mini",
          "name": "GPT-4o mini",
          "reasoning": false,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
MODELJSON
    log "✓ models.json generated for OpenAI"
  else
    # Fallback: use template as-is
    cp "$TEMPLATE" /tmp/iris-models.json
    log "⚠ Using template models.json — edit data/models.json manually if needed"
  fi

  # Stash for use in step 5
  GENERATED_MODELS_JSON=/tmp/iris-models.json

else
  # ── Restore mode: validate required vars ──
  [[ -z "$IRIS_PROVIDER" ]] && IRIS_PROVIDER="foundry-e2"
  [[ -z "$IRIS_MODEL" ]]    && IRIS_MODEL="gpt-4o"
  GENERATED_MODELS_JSON=""
fi

# ────────────────────────────────────────────────────────────
# 5. DNS + NSG setup (only if IRIS_BASE_DOMAIN is set)
# ────────────────────────────────────────────────────────────
if [[ -n "$IRIS_BASE_DOMAIN" ]]; then
  log_h "Public networking ($IRIS_BASE_DOMAIN)"

  VM_NAME=$(curl -sf -H Metadata:true \
    "http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text" || echo "")
  VM_RG=$(curl -sf -H Metadata:true \
    "http://169.254.169.254/metadata/instance/compute/resourceGroupName?api-version=2021-02-01&format=text" || echo "")

  if [[ -n "$VM_NAME" && -n "$VM_RG" ]]; then
    PUBLIC_IP=$(az network public-ip list -g "$VM_RG" \
      --query "[0].ipAddress" -o tsv 2>/dev/null || echo "")

    if [[ -n "$PUBLIC_IP" ]]; then
      log "VM: $VM_NAME ($VM_RG) — public IP: $PUBLIC_IP"

      PARENT_ZONE=$(echo "$IRIS_BASE_DOMAIN" | sed 's/^[^.]*\.//')
      DNS_PREFIX=$(echo "$IRIS_BASE_DOMAIN" | cut -d. -f1)
      DNS_ZONE_RG=$(az network dns zone list \
        --query "[?name=='$PARENT_ZONE'].resourceGroup | [0]" -o tsv 2>/dev/null || echo "")

      if [[ -n "$DNS_ZONE_RG" ]]; then
        log "DNS zone: $PARENT_ZONE (rg: $DNS_ZONE_RG)"
        for record in "$DNS_PREFIX" "*.$DNS_PREFIX"; do
          az network dns record-set a create \
            --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
            -n "$record" --ttl 300 2>/dev/null || true
          az network dns record-set a remove-record \
            --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
            -n "$record" --ipv4-address "$PUBLIC_IP" 2>/dev/null || true
          az network dns record-set a add-record \
            --zone-name "$PARENT_ZONE" -g "$DNS_ZONE_RG" \
            -n "$record" --ipv4-address "$PUBLIC_IP" 2>/dev/null
          log "DNS: $record.$PARENT_ZONE → $PUBLIC_IP"
        done
      else
        log "Warning: DNS zone '$PARENT_ZONE' not found — set DNS records manually"
      fi

      NSG_NAME=$(az network nsg list -g "$VM_RG" --query "[0].name" -o tsv 2>/dev/null || echo "")
      if [[ -n "$NSG_NAME" ]]; then
        for rule in "AllowHTTP:80:100" "AllowHTTPS:443:101"; do
          rname=$(echo "$rule" | cut -d: -f1)
          rport=$(echo "$rule" | cut -d: -f2)
          rprio=$(echo "$rule" | cut -d: -f3)
          existing=$(az network nsg rule show --nsg-name "$NSG_NAME" -g "$VM_RG" -n "$rname" 2>/dev/null || echo "")
          if [[ -z "$existing" ]]; then
            az network nsg rule create --nsg-name "$NSG_NAME" -g "$VM_RG" \
              -n "$rname" --priority "$rprio" \
              --destination-port-ranges "$rport" \
              --access Allow --protocol Tcp --direction Inbound -o none
            log "NSG: opened port $rport"
          else
            log "NSG: port $rport already open"
          fi
        done
      fi
    fi
  fi

  [[ -z "$CERTBOT_EMAIL" ]] && CERTBOT_EMAIL="admin@${PARENT_ZONE:-$IRIS_BASE_DOMAIN}"

  log "Writing base nginx config..."
  sudo tee /etc/nginx/sites-available/iris-default > /dev/null <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 404;
}
NGINX
  sudo ln -sfn /etc/nginx/sites-available/iris-default /etc/nginx/sites-enabled/iris-default
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t 2>/dev/null && sudo systemctl reload nginx
  log "nginx ready"
fi

# ────────────────────────────────────────────────────────────
# 6. Resolve Key Vault
# ────────────────────────────────────────────────────────────
log_h "Key Vault"
if [[ -n "$KV_NAME" ]]; then
  log "Using Key Vault: $KV_NAME"
elif [[ -n "$KV_RESOURCE_GROUP" ]]; then
  log "Looking up Key Vault in '$KV_RESOURCE_GROUP'..."
  KV_NAME=$(az keyvault list \
    --resource-group "$KV_RESOURCE_GROUP" \
    --query "[0].name" -o tsv 2>/dev/null || true)
fi
[[ -z "$KV_NAME" ]] && die "No Key Vault found. Run with --setup, or set KV_NAME=<vault-name>."
log "Key Vault: $KV_NAME"

# ────────────────────────────────────────────────────────────
# 7. Fetch secrets from Key Vault
# ────────────────────────────────────────────────────────────
log_h "Fetching secrets"

fetch_secret() {
  az keyvault secret show --vault-name "$KV_NAME" --name "$1" --query value -o tsv 2>/dev/null || true
}

ANTHROPIC_API_KEY=$(fetch_secret "ANTHROPIC-API-KEY")
OPENAI_API_KEY=$(fetch_secret "OPENAI-API-KEY")
FOUNDRY_E2_KEY=$(fetch_secret "FOUNDRY-E2-KEY")
GITHUB_TOKEN=$(fetch_secret "GITHUB-TOKEN")
SLACK_APP_TOKEN=$(fetch_secret "SLACK-APP-TOKEN")
SLACK_BOT_TOKEN=$(fetch_secret "SLACK-BOT-TOKEN")
RESEND_API_KEY=$(fetch_secret "RESEND-API-KEY")

# Validate at least one LLM key
if [[ -z "$ANTHROPIC_API_KEY" && -z "$OPENAI_API_KEY" && -z "$FOUNDRY_E2_KEY" ]]; then
  die "No LLM API key found in Key Vault '$KV_NAME'. Run --setup or seed ANTHROPIC-API-KEY / OPENAI-API-KEY / FOUNDRY-E2-KEY manually."
fi

# Warn (not die) if Slack is missing — lets people test without Slack first
if [[ -z "$SLACK_APP_TOKEN" || -z "$SLACK_BOT_TOKEN" ]]; then
  log "Warning: Slack tokens not found — Iris will start but won't connect to Slack."
  log "  Add SLACK-APP-TOKEN and SLACK-BOT-TOKEN to Key Vault when ready."
fi

# ────────────────────────────────────────────────────────────
# 8. Workspace setup
# ────────────────────────────────────────────────────────────
log_h "Workspace"
resolve_repo_dir

sudo mkdir -p "$IRIS_DIR"
sudo chown "$USER:$USER" "$IRIS_DIR"

if [[ "$REPO_DIR" == "${IRIS_DIR}/repo" ]]; then
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    [[ -z "$REPO_URL" ]] && REPO_URL=$(git -C "$(dirname "$0")" remote get-url origin 2>/dev/null || true)
    [[ -z "$REPO_URL" ]] && die "Cannot determine repo URL. Set REPO_URL=https://github.com/your-org/iris-core.git"
    log "Cloning $REPO_URL → $REPO_DIR..."
    git clone "$REPO_URL" "$REPO_DIR"
  else
    log "Updating repo at $REPO_DIR..."
    git -C "$REPO_DIR" pull --ff-only 2>/dev/null || log "Warning: could not pull latest — continuing with current checkout"
  fi
else
  [[ -d "$REPO_DIR/.git" ]] || die "REPO_DIR '$REPO_DIR' is not a git checkout."
  log "Using local repo at $REPO_DIR"
  ln -sfn "$REPO_DIR" "$IRIS_DIR/repo"
fi

mkdir -p "$IRIS_DIR/data"
ln -sfn "$REPO_DIR/MEMORY.md"       "$IRIS_DIR/data/MEMORY.md"
ln -sfn "$REPO_DIR/CONSTITUTION.md" "$IRIS_DIR/data/CONSTITUTION.md"
ln -sfn "$REPO_DIR/skills"          "$IRIS_DIR/data/skills"

# models.json: use generated (from --setup) or template fallback
if [[ -n "$GENERATED_MODELS_JSON" && -f "$GENERATED_MODELS_JSON" ]]; then
  cp "$GENERATED_MODELS_JSON" "$IRIS_DIR/data/models.json"
elif [[ -f "$REPO_DIR/data/models.json" ]]; then
  cp "$REPO_DIR/data/models.json" "$IRIS_DIR/data/models.json"
elif [[ -f "$REPO_DIR/data/models.json.template" ]]; then
  cp "$REPO_DIR/data/models.json.template" "$IRIS_DIR/data/models.json"
  log "Warning: using models.json.template — edit $IRIS_DIR/data/models.json to configure your provider"
fi

# Write .env
log "Writing /iris/.env..."
cat > "$IRIS_DIR/.env" << ENV
IRIS_PROVIDER=${IRIS_PROVIDER}
IRIS_MODEL=${IRIS_MODEL}
IRIS_ENV=${IRIS_ENV}

FOUNDRY_E2_KEY=${FOUNDRY_E2_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}

IRIS_SLACK_APP_TOKEN=${SLACK_APP_TOKEN:-}
IRIS_SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}

GITHUB_TOKEN=${GITHUB_TOKEN:-}
RESEND_API_KEY=${RESEND_API_KEY:-}

AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}
IRIS_KEY_VAULT=${KV_NAME}
IRIS_REPO_DIR=${REPO_DIR}
IRIS_STORAGE_ROOT=${IRIS_DIR}/data

IRIS_BASE_DOMAIN=${IRIS_BASE_DOMAIN:-}
CERTBOT_EMAIL=${CERTBOT_EMAIL:-}
GIT_USER_EMAIL=${GIT_USER_EMAIL:-iris@example.com}
ENV
chmod 600 "$IRIS_DIR/.env"

# ────────────────────────────────────────────────────────────
# 9. Build iris-runtime
# ────────────────────────────────────────────────────────────
log_h "Building iris-runtime"
RUNTIME_DIR="$REPO_DIR/iris-runtime"
cd "$RUNTIME_DIR"
npm install --prefer-offline 2>&1 | tail -3
npm run build 2>&1 | tail -5
cd - > /dev/null

# ────────────────────────────────────────────────────────────
# 10. Systemd service
# ────────────────────────────────────────────────────────────
log_h "Installing systemd service"
NODE_BIN="$(which node)"
IRIS_RUNTIME_BIN="$REPO_DIR/iris-runtime/dist/main.js"

sudo tee /etc/systemd/system/iris.service > /dev/null << UNIT
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
sleep 3

if ! sudo systemctl is-active --quiet iris; then
  sudo journalctl -u iris -n 50 --no-pager || true
  die "iris.service failed to start. Check logs above."
fi

# ────────────────────────────────────────────────────────────
# Done
# ────────────────────────────────────────────────────────────
log_h "Done"
log ""
log "  ✓ Iris is running!"
log ""
log "  Status:    sudo systemctl status iris"
log "  Logs:      sudo journalctl -u iris -f"
log "  Provider:  ${IRIS_PROVIDER}/${IRIS_MODEL}"
log "  Key Vault: ${KV_NAME}"
log "  Workspace: ${IRIS_DIR}"
log ""
if [[ -n "$SLACK_APP_TOKEN" ]]; then
  log "  Slack:     @iris in any channel"
else
  log "  Slack:     not configured (add SLACK-APP-TOKEN / SLACK-BOT-TOKEN to Key Vault)"
fi
log ""
