#!/usr/bin/env bash
# ============================================================
# Iris Bootstrap Script
#
# Modes:
#
#   First-time setup (will ask whether to use Key Vault):
#     bash bootstrap.sh --setup
#
#   First-time setup, secrets in Azure Key Vault:
#     bash bootstrap.sh --setup --keyvault
#
#   First-time setup, secrets stored directly in /iris/.env:
#     bash bootstrap.sh --setup --no-keyvault
#
#   Re-deploy, Key Vault + secrets already exist:
#     KV_NAME=<vault> bash bootstrap.sh
#
#   Re-deploy, /iris/.env already exists:
#     bash bootstrap.sh --no-keyvault
#
#   Install Firecracker + build rootfs (run once on a KVM-capable VM):
#     bash bootstrap.sh --firecracker
#
#   Combine flags:
#     bash bootstrap.sh --setup --no-keyvault --firecracker   # no Azure, isolated microVMs
#     bash bootstrap.sh --setup --keyvault --firecracker      # Azure Key Vault + microVMs
#     bash bootstrap.sh --setup --firecracker --pool          # dynamic pool (fresh VM per channel)
#
# All config can be passed via env vars to skip prompts.
# ============================================================
set -euo pipefail

IRIS_DIR="/iris"
REPO_URL="${REPO_URL:-}"
IRIS_CORE_URL="${IRIS_CORE_URL:-https://github.com/irisworks/irisflow.git}"
KV_NAME="${KV_NAME:-}"
KV_RESOURCE_GROUP="${KV_RESOURCE_GROUP:-}"
REPO_DIR="${REPO_DIR:-}"
SETUP_MODE=false
NO_KEYVAULT=false
KEYVAULT_EXPLICIT=false   # true when --keyvault or --no-keyvault was passed
FIRECRACKER_MODE=false
SA_NAME="${SA_NAME:-}"
FIRECRACKER_SANDBOX="${FIRECRACKER_SANDBOX:-static}"
SANDBOX_FLAG=""
FC_GUEST_IP="172.20.1.2"

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
  local prompt="$1" default="${2:-y}"
  local yn_hint; [[ "$default" == "y" ]] && yn_hint="[Y/n]" || yn_hint="[y/N]"
  read -r -p "[iris-bootstrap] $prompt $yn_hint " answer
  answer="${answer:-$default}"
  [[  "${answer,,}" == "y" ]]
}
prompt() {
  local question="$1" default="${2:-}"
  local hint; [[ -n "$default" ]] && hint=" [$default]" || hint=""
  read -r -p "[iris-bootstrap] $question$hint: " answer
  echo "${answer:-$default}"
}
prompt_secret() {
  local question="$1"
  read -r -s -p "[iris-bootstrap] $question: " answer
  echo "" >&2
  echo "$answer"
}

# ────────────────────────────────────────────────────────────
# Parse args
# ────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --setup)        SETUP_MODE=true ;;
    --no-keyvault)  NO_KEYVAULT=true;  KEYVAULT_EXPLICIT=true ;;
    --keyvault)     NO_KEYVAULT=false; KEYVAULT_EXPLICIT=true ;;
    --firecracker)  FIRECRACKER_MODE=true ;;
    --pool)         FIRECRACKER_SANDBOX="pool" ;;
    --static)       FIRECRACKER_SANDBOX="static" ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

# In setup mode, if neither --keyvault nor --no-keyvault was passed,
# ask the user which storage method they want.
if [[ "$SETUP_MODE" == true && "$KEYVAULT_EXPLICIT" == false ]]; then
  echo ""
  echo "  Where should Iris store secrets?"
  echo ""
  echo "  1) Azure Key Vault  — recommended for production; requires Azure account"
  echo "  2) /iris/.env file  — simpler; no Azure required; keep the file secure"
  echo ""
  read -r -p "[iris-bootstrap] Choice [1]: " kv_choice
  case "${kv_choice:-1}" in
    2) NO_KEYVAULT=true  ;;
    *) NO_KEYVAULT=false ;;
  esac
  echo ""
fi

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

# Azure CLI only needed when using Key Vault
if [[ "$NO_KEYVAULT" == false ]] && ! command -v az &>/dev/null; then
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
# 1b. Firecracker (optional — only when --firecracker is passed)
# ────────────────────────────────────────────────────────────
if [[ "$FIRECRACKER_MODE" == true ]]; then
  log_h "Firecracker setup"

  # Verify KVM is available (requires nested-virt or bare-metal)
  if [[ ! -e /dev/kvm ]]; then
    log "WARNING: /dev/kvm not found. Firecracker requires KVM."
    log "On Azure, use a Ddsv5-series VM or enable nested virtualisation."
    log "Skipping Firecracker install."
  else
    FC_VERSION="${FC_VERSION:-1.7.0}"
    FC_BIN="/usr/local/bin/firecracker"
    JAILER_BIN="/usr/local/bin/jailer"

    if [[ ! -f "$FC_BIN" ]]; then
      log "Downloading Firecracker v${FC_VERSION}..."
      FC_ARCH=$(uname -m)  # x86_64 or aarch64
      FC_TGZ="/tmp/firecracker-v${FC_VERSION}-${FC_ARCH}.tgz"
      curl -Lo "$FC_TGZ" \
        "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${FC_ARCH}.tgz"
      tar -xzf "$FC_TGZ" -C /tmp
      sudo install "/tmp/release-v${FC_VERSION}-${FC_ARCH}/firecracker-v${FC_VERSION}-${FC_ARCH}" "$FC_BIN"
      sudo install "/tmp/release-v${FC_VERSION}-${FC_ARCH}/jailer-v${FC_VERSION}-${FC_ARCH}" "$JAILER_BIN"
      rm -f "$FC_TGZ"
      log "Firecracker installed: $($FC_BIN --version)"
    else
      log "Firecracker already installed: $($FC_BIN --version)"
    fi

    # Jailer system user (uid/gid 10000)
    if ! id irisjailer &>/dev/null; then
      log "Creating irisjailer system user (uid/gid 10000)..."
      sudo groupadd -g 10000 irisjailer 2>/dev/null || true
      sudo useradd -u 10000 -g 10000 -r -s /usr/sbin/nologin irisjailer
    fi

    # KVM group membership for current user
    sudo usermod -aG kvm "$USER" 2>/dev/null || true

    # Kernel image
    VMLINUX="/var/lib/iris/firecracker/vmlinux"
    if [[ ! -f "$VMLINUX" ]]; then
      log "Downloading Firecracker-compatible kernel..."
      sudo mkdir -p "$(dirname "$VMLINUX")"
      FC_ARCH=$(uname -m)
      sudo curl -Lo "$VMLINUX" \
        "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/${FC_ARCH}/kernels/vmlinux.bin"
      log "Kernel downloaded: $VMLINUX"
    else
      log "Kernel already present: $VMLINUX"
    fi

    # Build rootfs (requires iris-runtime:local Docker image)
    ROOTFS="/var/lib/iris/firecracker/rootfs.ext4"
    if [[ ! -f "$ROOTFS" ]]; then
      log "Building Firecracker rootfs from iris-runtime Docker image..."
      log "(This requires iris-runtime:local to be built first — building now...)"
      # e2fsprogs provides mkfs.ext4, required by build-firecracker-rootfs.sh
      sudo apt-get install -y e2fsprogs
      resolve_repo_dir
      cd "$REPO_DIR/iris-runtime"
      npm ci --prefer-offline 2>/dev/null || npm install
      npm run build
      docker_cmd build -t iris-runtime:local .
      sudo bash "$REPO_DIR/scripts/build-firecracker-rootfs.sh"
    else
      log "Rootfs already present: $ROOTFS"
    fi

    log ""
    log "  Firecracker is ready. Next step:"
    log "  Uncomment a 'module \"public_sandbox\"' block in terraform/agents.tf"
    log "  and run: cd ${REPO_DIR:-/iris/repo}/terraform && terraform apply"
    log ""
  fi
fi

# ────────────────────────────────────────────────────────────
# 2. Azure login
# Skipped entirely when --no-keyvault is set (or user chose /iris/.env).
# When Key Vault is used, tries Managed Identity and service
# principal before falling back to interactive device login.
# ────────────────────────────────────────────────────────────
SUBSCRIPTION_ID=""

if [[ "$NO_KEYVAULT" == false ]]; then
  log_h "Azure login"

  if az account show &>/dev/null 2>&1; then
    log "Authenticated (Managed Identity or existing session)"
  elif [[ -n "${AZURE_CLIENT_ID:-}" && -n "${AZURE_CLIENT_SECRET:-}" && -n "${AZURE_TENANT_ID:-}" ]]; then
    log "Logging in via service principal..."
    az login --service-principal \
      -u "$AZURE_CLIENT_ID" -p "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID" -o none
  else
    log "No existing Azure session detected — starting interactive login..."
    log "(Tip: assign a Managed Identity to this VM to skip this step on future runs)"
    az login
  fi

  SUBSCRIPTION_ID=$(az account show --query id -o tsv)
  SUBSCRIPTION_NAME=$(az account show --query name -o tsv)
  log "Active subscription: $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)"

  SUBSCRIPTION_COUNT=$(az account list --query "length(@)" -o tsv 2>/dev/null || echo "1")
  if [[ "$SUBSCRIPTION_COUNT" -gt 1 ]]; then
    echo ""
    log "Available subscriptions:"
    az account list --query "[].{Name:name, ID:id, Default:isDefault}" -o table
    echo ""
    chosen=$(prompt "Subscription ID or name to use" "$SUBSCRIPTION_ID")
    if [[ "$chosen" != "$SUBSCRIPTION_ID" ]]; then
      az account set --subscription "$chosen"
      SUBSCRIPTION_ID=$(az account show --query id -o tsv)
      SUBSCRIPTION_NAME=$(az account show --query name -o tsv)
      log "Switched to: $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)"
    fi
  fi
else
  log_h "Azure (skipped — using /iris/.env for secrets)"
fi

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
# Shared: prompt for all secrets
# Called in --setup mode (both paths) and in --no-keyvault
# restore mode when /iris/.env does not yet exist.
# Sets: IRIS_PROVIDER, IRIS_MODEL, LLM_API_KEY, FOUNDRY_ACCOUNT,
#       AWS_ACCESS_KEY_INPUT, AWS_SECRET_KEY_INPUT, AWS_REGION_INPUT,
#       AWS_PROFILE_INPUT, SLACK_APP_TOKEN, SLACK_BOT_TOKEN,
#       GITHUB_TOKEN, RESEND_API_KEY, IRIS_BASE_DOMAIN,
#       CERTBOT_EMAIL, GIT_USER_EMAIL
# ────────────────────────────────────────────────────────────
prompt_secrets() {
  # ── LLM Provider ──
  if [[ -z "$IRIS_PROVIDER" ]]; then
    echo "[iris-bootstrap] Choose LLM provider:"
    echo "  1) anthropic       — Claude Sonnet / Opus (recommended)"
    echo "  2) openai          — GPT-4o / GPT-4"
    echo "  3) foundry-e2      — Azure AI Foundry (Azure OpenAI)"
    echo "  4) amazon-bedrock  — AWS Bedrock (Claude, Llama, Nova)"
    read -r -p "[iris-bootstrap] Choice [1]: " provider_choice
    case "${provider_choice:-1}" in
      1) IRIS_PROVIDER="anthropic" ;;
      2) IRIS_PROVIDER="openai" ;;
      3) IRIS_PROVIDER="foundry-e2" ;;
      4) IRIS_PROVIDER="amazon-bedrock" ;;
      *) IRIS_PROVIDER="anthropic" ;;
    esac
  fi

  # ── Model ──
  if [[ -z "$IRIS_MODEL" ]]; then
    case "$IRIS_PROVIDER" in
      anthropic)      default_model="claude-sonnet-4-5" ;;
      openai)         default_model="gpt-4o" ;;
      foundry-e2)     default_model="gpt-4o" ;;
      amazon-bedrock) default_model="us.anthropic.claude-sonnet-4-6" ;;
      *)              default_model="gpt-4o" ;;
    esac
    IRIS_MODEL=$(prompt "Model" "$default_model")
  fi
  log "Provider: $IRIS_PROVIDER / $IRIS_MODEL"

  # ── API Key / Credentials ──
  LLM_API_KEY=""
  FOUNDRY_ACCOUNT=""
  AWS_REGION_INPUT=""
  AWS_ACCESS_KEY_INPUT=""
  AWS_SECRET_KEY_INPUT=""
  AWS_PROFILE_INPUT=""

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
    amazon-bedrock)
      echo ""
      echo "  ┌─ AWS Bedrock Credentials ───────────────────────────────────────┐"
      echo "  │  1) IAM Role  — instance profile, no keys needed              │"
      echo "  │  2) Access key + secret                                        │"
      echo "  │  3) Named AWS profile (~/.aws/config)                          │"
      echo "  └────────────────────────────────────────────────────────────────────┘"
      read -r -p "[iris-bootstrap] Credential method [1]: " bedrock_cred_choice
      case "${bedrock_cred_choice:-1}" in
        2)
          AWS_ACCESS_KEY_INPUT=$(prompt_secret "AWS Access Key ID (AKIA...)")
          AWS_SECRET_KEY_INPUT=$(prompt_secret "AWS Secret Access Key")
          [[ -z "$AWS_ACCESS_KEY_INPUT" ]] && die "AWS Access Key ID is required."
          [[ -z "$AWS_SECRET_KEY_INPUT" ]] && die "AWS Secret Access Key is required."
          ;;
        3)
          AWS_PROFILE_INPUT=$(prompt "AWS profile name" "default")
          ;;
        *) log "Using IAM instance role — no credentials needed." ;;
      esac
      AWS_REGION_INPUT=$(prompt "AWS region for Bedrock" "us-east-1")
      ;;
  esac

  # ── Slack ──
  echo ""
  SLACK_APP_TOKEN=""
  SLACK_BOT_TOKEN=""
  if confirm "Set up Slack integration?"; then
    echo ""
    echo "  ┌─ Slack App Setup ────────────────────────────────────────────┐"
    echo "  │                                                               │"
    echo "  │  1. Go to https://api.slack.com/apps → Create New App        │"
    echo "  │     → From scratch → name it 'Iris' → pick your workspace    │"
    echo "  │                                                               │"
    echo "  │  2. Socket Mode (left sidebar)                                │"
    echo "  │     → Enable Socket Mode → generate App-Level Token          │"
    echo "  │     → name it 'iris-socket' → scope: connections:write       │"
    echo "  │     → copy the  xapp-...  token  (App Token)                 │"
    echo "  │                                                               │"
    echo "  │  3. OAuth & Permissions (left sidebar)                        │"
    echo "  │     → Bot Token Scopes → Add:                                 │"
    echo "  │         app_mentions:read  channels:history  channels:read    │"
    echo "  │         chat:write         groups:history    groups:read      │"
    echo "  │         im:history         im:read           im:write         │"
    echo "  │         mpim:history       reactions:write   users:read       │"
    echo "  │     → Install to Workspace → copy the  xoxb-...  token       │"
    echo "  │                                                               │"
    echo "  │  4. Event Subscriptions → Enable → subscribe to bot events:   │"
    echo "  │         app_mention  message.channels  message.groups        │"
    echo "  │         message.im   message.mpim                            │"
    echo "  │                                                               │"
    echo "  │  5. App Home → enable Messages Tab                           │"
    echo "  │                                                               │"
    echo "  │  Note: Make sure to store the xapp and xoxb tokens securely  │"
    echo "  │  as they will be required in the next steps.                 │"
    echo "  └───────────────────────────────────────────────────────────────────┘"
    echo ""
    read -r -p "[iris-bootstrap] Press Enter when your app is created and tokens are ready..."
    SLACK_APP_TOKEN=$(prompt_secret "Slack App token (xapp-...)")
    SLACK_BOT_TOKEN=$(prompt_secret "Slack Bot token (xoxb-...)")
    [[ -z "$SLACK_APP_TOKEN" ]] && die "Slack App token is required."
    [[ -z "$SLACK_BOT_TOKEN" ]] && die "Slack Bot token is required."
    [[ "$SLACK_APP_TOKEN" != xapp-* ]] && die "Slack App token must start with 'xapp-'. Got: ${SLACK_APP_TOKEN:0:10}..."
    [[ "$SLACK_BOT_TOKEN" != xoxb-* ]] && die "Slack Bot token must start with 'xoxb-'. Got: ${SLACK_BOT_TOKEN:0:10}..."
  else
    log "Skipping Slack — you can add IRIS_SLACK_APP_TOKEN / IRIS_SLACK_BOT_TOKEN to /iris/.env later."
  fi

  # ── GitHub token ──
  GITHUB_TOKEN=""
  if confirm "Add GitHub token for repo access?"; then
    echo ""
    echo "  ┌─ GitHub Token Setup ────────────────────────────────────────────┐"
    echo "  │  1. https://github.com/settings/tokens                        │"
    echo "  │     → Fine-grained personal access tokens → Generate new      │"
    echo "  │  2. Permissions: Contents, Pull requests, Issues (read/write) │"
    echo "  │  3. Copy the  github_pat_...  value                           │"
    echo "  └────────────────────────────────────────────────────────────────────┘"
    echo ""
    read -r -p "[iris-bootstrap] Press Enter when your token is ready..."
    GITHUB_TOKEN=$(prompt_secret "GitHub token (github_pat_... or ghp_...)")
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

  # ── Terraform state storage (Firecracker + Azure path only) ──
  if [[ "$FIRECRACKER_MODE" == true && "$NO_KEYVAULT" == false && -z "$SA_NAME" ]]; then
    suggested_sa="iristfstate$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-10)"
    SA_NAME=$(prompt "Terraform state storage account name (lowercase + numbers, max 24 chars)" "$suggested_sa")
  fi
}

# ────────────────────────────────────────────────────────────
# 4. Secret configuration
# ────────────────────────────────────────────────────────────
GENERATED_MODELS_JSON=""

# Variables written to .env — initialise so step 8 always has them
ANTHROPIC_API_KEY=""
OPENAI_API_KEY=""
FOUNDRY_E2_KEY=""
AWS_ACCESS_KEY_ID=""
AWS_SECRET_ACCESS_KEY=""
AWS_REGION=""
AWS_PROFILE=""
SLACK_APP_TOKEN=""
SLACK_BOT_TOKEN=""
GITHUB_TOKEN=""
RESEND_API_KEY=""
LLM_API_KEY=""
FOUNDRY_ACCOUNT=""
AWS_ACCESS_KEY_INPUT=""
AWS_SECRET_KEY_INPUT=""
AWS_REGION_INPUT=""
AWS_PROFILE_INPUT=""

if [[ "$NO_KEYVAULT" == false ]]; then
  # ── Key Vault path ───────────────────────────────────────────────
  if [[ "$SETUP_MODE" == true ]]; then
    log_h "First-time setup"
    echo ""
    echo "  Secrets will be stored in Azure Key Vault — never on disk."
    echo ""

    prompt_secrets

    # ── Key Vault creation ──
    echo ""
    log_h "Key Vault setup"

    if [[ -z "$KV_NAME" ]]; then
      suggested="iris-kv-$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-12 | sed 's/-*$//')"
      KV_NAME=$(prompt "Key Vault name (must be globally unique)" "$suggested")
    fi

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

    if az keyvault show --name "$KV_NAME" &>/dev/null 2>&1; then
      log "Key Vault '$KV_NAME' already exists — reusing."
    else
      log "Creating Key Vault '$KV_NAME' in '$KV_RESOURCE_GROUP'..."
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

    CURRENT_USER_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
    if [[ -n "$CURRENT_USER_ID" ]]; then
      az keyvault set-policy \
        --name "$KV_NAME" \
        --object-id "$CURRENT_USER_ID" \
        --secret-permissions get list set delete \
        -o none 2>/dev/null || true
    fi

    log "Seeding secrets into Key Vault..."
    seed_secret() {
      local name="$1" value="$2"
      [[ -z "$value" ]] && return
      az keyvault secret set --vault-name "$KV_NAME" --name "$name" --value "$value" -o none
      log "  ✓ $name"
    }
    case "$IRIS_PROVIDER" in
      anthropic)      seed_secret "ANTHROPIC-API-KEY"     "$LLM_API_KEY" ;;
      openai)         seed_secret "OPENAI-API-KEY"        "$LLM_API_KEY" ;;
      foundry-e2)     seed_secret "FOUNDRY-E2-KEY"        "$LLM_API_KEY" ;;
      amazon-bedrock) seed_secret "AWS-ACCESS-KEY-ID"     "${AWS_ACCESS_KEY_INPUT:-}"
                      seed_secret "AWS-SECRET-ACCESS-KEY" "${AWS_SECRET_KEY_INPUT:-}"
                      seed_secret "AWS-REGION"            "${AWS_REGION_INPUT:-us-east-1}"
                      seed_secret "AWS-PROFILE"           "${AWS_PROFILE_INPUT:-}" ;;
    esac
    seed_secret "SLACK-APP-TOKEN" "$SLACK_APP_TOKEN"
    seed_secret "SLACK-BOT-TOKEN" "$SLACK_BOT_TOKEN"
    seed_secret "GITHUB-TOKEN"    "$GITHUB_TOKEN"
    seed_secret "RESEND-API-KEY"  "$RESEND_API_KEY"
    log "✓ Secrets seeded."
  else
    # Restore mode — defaults only
    [[ -z "$IRIS_PROVIDER" ]] && IRIS_PROVIDER="foundry-e2"
    [[ -z "$IRIS_MODEL" ]]    && IRIS_MODEL="gpt-4o"
  fi

else
  # ── No-Key-Vault path ───────────────────────────────────────────────
  if [[ "$SETUP_MODE" == true ]] || [[ ! -f "$IRIS_DIR/.env" ]]; then
    log_h "Secret configuration (stored in /iris/.env)"
    echo ""
    echo "  Secrets will be written directly to /iris/.env (chmod 600)."
    echo "  No Azure Key Vault will be used."
    echo "  Keep /iris/.env secure — it contains your API keys."
    echo ""
    prompt_secrets
  else
    log_h "Using existing /iris/.env — skipping secret prompts"
    log "  Re-run with --setup --no-keyvault to update secrets."
    # Source existing .env so step 8 can rewrite it with any new env vars
    set +u
    # shellcheck disable=SC1090
    source "$IRIS_DIR/.env" 2>/dev/null || true
    set -u
    IRIS_PROVIDER="${IRIS_PROVIDER:-foundry-e2}"
    IRIS_MODEL="${IRIS_MODEL:-gpt-4o}"
    SLACK_APP_TOKEN="${IRIS_SLACK_APP_TOKEN:-}"
    SLACK_BOT_TOKEN="${IRIS_SLACK_BOT_TOKEN:-}"
    if [[ -n "$SLACK_APP_TOKEN" && "$SLACK_APP_TOKEN" != xapp-* ]]; then
      die "IRIS_SLACK_APP_TOKEN in /iris/.env looks wrong (expected xapp-... prefix). Fix it and re-run."
    fi
    if [[ -n "$SLACK_BOT_TOKEN" && "$SLACK_BOT_TOKEN" != xoxb-* ]]; then
      die "IRIS_SLACK_BOT_TOKEN in /iris/.env looks wrong (expected xoxb-... prefix). Fix it and re-run."
    fi
    AWS_ACCESS_KEY_INPUT="${AWS_ACCESS_KEY_ID:-}"
    AWS_SECRET_KEY_INPUT="${AWS_SECRET_ACCESS_KEY:-}"
    AWS_REGION_INPUT="${AWS_REGION:-}"
    AWS_PROFILE_INPUT="${AWS_PROFILE:-}"
  fi
fi

# ── Map prompted values to .env variable names ────────────────────
# (only needed for --no-keyvault path; Key Vault path populates
#  these from fetch_secret in step 7)
if [[ "$NO_KEYVAULT" == true ]]; then
  case "$IRIS_PROVIDER" in
    anthropic)      ANTHROPIC_API_KEY="${LLM_API_KEY:-}" ;;
    openai)         OPENAI_API_KEY="${LLM_API_KEY:-}" ;;
    foundry-e2)     FOUNDRY_E2_KEY="${LLM_API_KEY:-}" ;;
    amazon-bedrock) AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_INPUT:-}"
                    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_KEY_INPUT:-}"
                    AWS_REGION="${AWS_REGION_INPUT:-}"
                    AWS_PROFILE="${AWS_PROFILE_INPUT:-}" ;;
  esac
fi

# ── Generate models.json (setup mode only) ────────────────────────────
if [[ "$SETUP_MODE" == true ]]; then
  log_h "Generating models.json"
  TEMPLATE="$( cd "$(dirname "$0")" && pwd )/data/models.json.template"

  if [[ "$IRIS_PROVIDER" == "foundry-e2" && -n "${FOUNDRY_ACCOUNT:-}" ]]; then
    sed "s|<your-account>|${FOUNDRY_ACCOUNT}|g" "$TEMPLATE" > /tmp/iris-models.json
    log "✓ models.json generated for Foundry account: $FOUNDRY_ACCOUNT"
  elif [[ "$IRIS_PROVIDER" == "anthropic" ]]; then
    cat > /tmp/iris-models.json << 'MODELJSON'
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com/v1",
      "api": "anthropic",
      "apiKey": "ANTHROPIC_API_KEY",
      "models": [
        { "id": "claude-sonnet-4",   "name": "Claude Sonnet 4",   "reasoning": false, "input": ["text","image"], "contextWindow": 200000, "maxTokens": 16000, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "claude-opus-4",     "name": "Claude Opus 4",     "reasoning": true,  "input": ["text","image"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "claude-haiku-4-5",  "name": "Claude Haiku 4.5",  "reasoning": false, "input": ["text","image"], "contextWindow": 200000, "maxTokens": 8096,  "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} }
      ]
    }
  }
}
MODELJSON
    log "✓ models.json generated for Anthropic"
  elif [[ "$IRIS_PROVIDER" == "openai" ]]; then
    cat > /tmp/iris-models.json << 'MODELJSON'
{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKey": "OPENAI_API_KEY",
      "models": [
        { "id": "gpt-4o",      "name": "GPT-4o",      "reasoning": false, "input": ["text","image"], "contextWindow": 128000, "maxTokens": 16384, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "gpt-4o-mini", "name": "GPT-4o mini", "reasoning": false, "input": ["text","image"], "contextWindow": 128000, "maxTokens": 16384, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} }
      ]
    }
  }
}
MODELJSON
    log "✓ models.json generated for OpenAI"
  elif [[ "$IRIS_PROVIDER" == "amazon-bedrock" ]]; then
    BEDROCK_REGION="${AWS_REGION_INPUT:-us-east-1}"
    cat > /tmp/iris-models.json << MODELJSON
{
  "providers": {
    "amazon-bedrock": {
      "baseUrl": "bedrock://${BEDROCK_REGION}",
      "api": "bedrock-converse-stream",
      "apiKey": "AWS_PROFILE",
      "models": [
        { "id": "us.anthropic.claude-sonnet-4-6",            "name": "Claude Sonnet 4.6 (Bedrock)", "reasoning": false, "input": ["text","image"], "contextWindow": 200000, "maxTokens": 16000, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "us.anthropic.claude-opus-4-6-v1",           "name": "Claude Opus 4.6 (Bedrock)",   "reasoning": true,  "input": ["text","image"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "name": "Claude Sonnet 4.5 (Bedrock)", "reasoning": false, "input": ["text","image"], "contextWindow": 200000, "maxTokens": 16000, "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",  "name": "Claude Haiku 4.5 (Bedrock)",  "reasoning": false, "input": ["text","image"], "contextWindow": 200000, "maxTokens": 8096,  "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} },
        { "id": "amazon.nova-pro-v1:0",                       "name": "Amazon Nova Pro",             "reasoning": false, "input": ["text","image"], "contextWindow": 300000, "maxTokens": 5120,  "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} }
      ]
    }
  }
}
MODELJSON
    log "✓ models.json generated for Amazon Bedrock (region: $BEDROCK_REGION)"
  else
    cp "$TEMPLATE" /tmp/iris-models.json
    log "⚠ Using template models.json — edit $IRIS_DIR/data/models.json manually if needed"
  fi
  GENERATED_MODELS_JSON=/tmp/iris-models.json
fi

# ────────────────────────────────────────────────────────────
# 5. DNS + NSG setup (Azure only, only if IRIS_BASE_DOMAIN set)
# ────────────────────────────────────────────────────────────
if [[ -n "$IRIS_BASE_DOMAIN" && "$NO_KEYVAULT" == false ]]; then
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
elif [[ -n "$IRIS_BASE_DOMAIN" && "$NO_KEYVAULT" == true ]]; then
  log "Note: DNS/NSG setup skipped (requires Azure CLI). Configure your domain manually."
fi

# ────────────────────────────────────────────────────────────
# 6. Resolve Key Vault (skipped when --no-keyvault)
# ────────────────────────────────────────────────────────────
if [[ "$NO_KEYVAULT" == false ]]; then
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
fi

# ────────────────────────────────────────────────────────────
# 7. Fetch secrets from Key Vault (skipped when --no-keyvault)
# ────────────────────────────────────────────────────────────
if [[ "$NO_KEYVAULT" == false ]]; then
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
  AWS_ACCESS_KEY_ID=$(fetch_secret "AWS-ACCESS-KEY-ID")
  AWS_SECRET_ACCESS_KEY=$(fetch_secret "AWS-SECRET-ACCESS-KEY")
  AWS_REGION=$(fetch_secret "AWS-REGION")
  AWS_PROFILE=$(fetch_secret "AWS-PROFILE")

  if [[ -z "$ANTHROPIC_API_KEY" && -z "$OPENAI_API_KEY" && -z "$FOUNDRY_E2_KEY" && -z "$AWS_ACCESS_KEY_ID" && -z "$AWS_PROFILE" && "$IRIS_PROVIDER" != "amazon-bedrock" ]]; then
    die "No LLM API key found in Key Vault '$KV_NAME'. Run --setup or seed the key manually."
  fi

  if [[ -z "$SLACK_APP_TOKEN" || -z "$SLACK_BOT_TOKEN" ]]; then
    log "Warning: Slack tokens not found — Iris will start but won't connect to Slack."
    log "  Add SLACK-APP-TOKEN and SLACK-BOT-TOKEN to Key Vault when ready."
  fi
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

    if [[ -n "$GITHUB_TOKEN" ]]; then
      git config --global credential.helper store
      REPO_HOST=$(echo "$REPO_URL" | sed 's|https://||' | cut -d/ -f1)
      echo "https://${GITHUB_TOKEN}:x-oauth-basic@${REPO_HOST}" > ~/.git-credentials
      chmod 600 ~/.git-credentials
      log "GitHub credentials stored"
    fi

    log "Cloning $REPO_URL → $REPO_DIR..."
    git clone "$REPO_URL" "$REPO_DIR"
  else
    log "Updating repo at $REPO_DIR..."
    git -C "$REPO_DIR" pull --ff-only 2>/dev/null || log "Warning: could not pull latest — continuing with current checkout"
  fi

  CLEAN_URL=$(git -C "$REPO_DIR" remote get-url origin | sed 's|https://[^@]*@|https://|')
  git -C "$REPO_DIR" remote set-url origin "$CLEAN_URL"

  ORIGIN_URL=$(git -C "$REPO_DIR" remote get-url origin)
  if [[ "$ORIGIN_URL" != "$IRIS_CORE_URL" ]]; then
    if git -C "$REPO_DIR" remote get-url upstream &>/dev/null 2>&1; then
      git -C "$REPO_DIR" remote set-url upstream "$IRIS_CORE_URL"
      log "upstream remote updated → $IRIS_CORE_URL"
    else
      git -C "$REPO_DIR" remote add upstream "$IRIS_CORE_URL"
      log "upstream remote added → $IRIS_CORE_URL"
    fi
    git -C "$REPO_DIR" fetch upstream --quiet 2>/dev/null || log "Warning: could not fetch upstream — continuing (you can run 'git fetch upstream' manually later)"
    log "To merge future iris-core updates: git fetch upstream && git merge upstream/main"
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

if [[ -n "$GENERATED_MODELS_JSON" && -f "$GENERATED_MODELS_JSON" ]]; then
  cp "$GENERATED_MODELS_JSON" "$IRIS_DIR/data/models.json"
elif [[ -f "$REPO_DIR/data/models.json" ]]; then
  cp "$REPO_DIR/data/models.json" "$IRIS_DIR/data/models.json"
elif [[ -f "$REPO_DIR/data/models.json.template" ]]; then
  cp "$REPO_DIR/data/models.json.template" "$IRIS_DIR/data/models.json"
  log "Warning: using models.json.template — edit $IRIS_DIR/data/models.json to configure your provider"
fi

# Write /iris/.env
log "Writing /iris/.env..."
e() { printf '%s' "${1:-}" | tr -d '\n\r'; }  # strip newlines from a value
{
  echo "IRIS_PROVIDER=$(e "$IRIS_PROVIDER")"
  echo "IRIS_MODEL=$(e "$IRIS_MODEL")"
  echo "IRIS_ENV=$(e "$IRIS_ENV")"
  echo ""
  echo "FOUNDRY_E2_KEY=$(e "${FOUNDRY_E2_KEY:-}")"
  echo "ANTHROPIC_API_KEY=$(e "${ANTHROPIC_API_KEY:-}")"
  echo "OPENAI_API_KEY=$(e "${OPENAI_API_KEY:-}")"
  echo "AWS_ACCESS_KEY_ID=$(e "${AWS_ACCESS_KEY_ID:-}")"
  echo "AWS_SECRET_ACCESS_KEY=$(e "${AWS_SECRET_ACCESS_KEY:-}")"
  echo "AWS_REGION=$(e "${AWS_REGION:-}")"
  echo "AWS_PROFILE=$(e "${AWS_PROFILE:-}")"
  echo ""
  echo "IRIS_SLACK_APP_TOKEN=$(e "${SLACK_APP_TOKEN:-}")"
  echo "IRIS_SLACK_BOT_TOKEN=$(e "${SLACK_BOT_TOKEN:-}")"
  echo ""
  echo "GITHUB_TOKEN=$(e "${GITHUB_TOKEN:-}")"
  echo "RESEND_API_KEY=$(e "${RESEND_API_KEY:-}")"
  echo ""
  echo "AZURE_SUBSCRIPTION_ID=$(e "${SUBSCRIPTION_ID:-}")"
  echo "IRIS_KEY_VAULT=$(e "${KV_NAME:-}")"
  echo "IRIS_TF_STORAGE_ACCOUNT=$(e "${SA_NAME:-}")"
  echo "IRIS_REPO_DIR=$(e "$REPO_DIR")"
  echo "IRIS_STORAGE_ROOT=${IRIS_DIR}/data"
  echo ""
  echo "IRIS_BASE_DOMAIN=$(e "${IRIS_BASE_DOMAIN:-}")"
  echo "CERTBOT_EMAIL=$(e "${CERTBOT_EMAIL:-}")"
  echo "GIT_USER_EMAIL=$(e "${GIT_USER_EMAIL:-iris@example.com}")"
} | sudo tee "$IRIS_DIR/.env" > /dev/null
sudo chmod 600 "$IRIS_DIR/.env"
log "✓ /iris/.env written"

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
DOTENV_CONFIG="$RUNTIME_DIR/node_modules/dotenv/config"

# Remove any drop-in overrides that may have been created by previous sessions
# (e.g. switching sandbox to firecracker-pool without Firecracker installed)
sudo rm -rf /etc/systemd/system/iris.service.d

sudo tee /etc/systemd/system/iris.service > /dev/null << UNIT
[Unit]
Description=Iris Meta-Agent (iris-runtime)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${IRIS_DIR}
ExecStart=${NODE_BIN} --require ${DOTENV_CONFIG} ${IRIS_RUNTIME_BIN} --sandbox=host ${IRIS_DIR}/data
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

# Docker sub-agents service (calls agents/start-all.sh on boot)
sudo tee /etc/systemd/system/iris-agents.service > /dev/null << UNIT
[Unit]
Description=Iris Docker Sub-Agents
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash ${REPO_DIR}/agents/start-all.sh

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable iris-agents
log "✓ iris-agents.service installed and enabled"

# ────────────────────────────────────────────────────────────
# 11. Provision Firecracker sandbox VM
# ────────────────────────────────────────────────────────────
if [[ "$FIRECRACKER_MODE" == true ]]; then
  log_h "Provisioning Firecracker sandbox VM"

  ROOTFS="/var/lib/iris/firecracker/rootfs.ext4"
  [[ -f "$ROOTFS" ]] || die "Rootfs not found at $ROOTFS — Firecracker build may have failed above."

  if [[ "$NO_KEYVAULT" == true ]]; then
    # ── Direct bash path (no Terraform) ──────────────────────────────
    FC_AGENT_NAME="public-sandbox"
    FC_SLOT=1
    FC_AGENT_DIR="/var/lib/iris/firecracker/agents/${FC_AGENT_NAME}"
    FC_HOST_IP="172.20.${FC_SLOT}.1"
    FC_TAP="vmtap${FC_SLOT}"
    FC_MAC=$(printf "AA:FC:00:00:%02X:02" "$FC_SLOT")
    FC_CONFIG="${FC_AGENT_DIR}/vm-config.json"
    FC_LOG="/var/log/iris-fc-${FC_AGENT_NAME}.log"
    FC_SERVICE="iris-fc-${FC_AGENT_NAME}"

    sudo mkdir -p "$FC_AGENT_DIR"

    if [[ ! -f "${FC_AGENT_DIR}/rootfs.ext4" ]]; then
      log "Copying base rootfs for ${FC_AGENT_NAME}..."
      sudo cp --sparse=always "$ROOTFS" "${FC_AGENT_DIR}/rootfs.ext4"
    fi

    log "Writing vm-config.json..."
    sudo tee "$FC_CONFIG" > /dev/null << JSON
{
  "boot-source": {
    "kernel_image_path": "/var/lib/iris/firecracker/vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off guestip=172.20.${FC_SLOT}.2 hostip=${FC_HOST_IP}"
  },
  "drives": [
    {
      "drive_id": "rootfs",
      "path_on_host": "${FC_AGENT_DIR}/rootfs.ext4",
      "is_root_device": true,
      "is_read_only": false
    }
  ],
  "machine-config": {
    "vcpu_count": 2,
    "mem_size_mib": 512
  },
  "network-interfaces": [
    {
      "iface_id": "eth0",
      "guest_mac": "${FC_MAC}",
      "host_dev_name": "${FC_TAP}"
    }
  ]
}
JSON

    log "Writing ${FC_SERVICE}.service..."
    sudo tee "/etc/systemd/system/${FC_SERVICE}.service" > /dev/null << UNIT
[Unit]
Description=Iris Firecracker Agent: ${FC_AGENT_NAME}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=on-failure
RestartSec=5

ExecStartPre=/bin/bash -c "\
  rm -f /run/iris-fc-${FC_AGENT_NAME}.socket; \
  ip link show ${FC_TAP} &>/dev/null || ip tuntap add dev ${FC_TAP} mode tap; \
  ip addr flush dev ${FC_TAP} 2>/dev/null || true; \
  ip addr add ${FC_HOST_IP}/30 dev ${FC_TAP}; \
  ip link set ${FC_TAP} up; \
  sysctl -w net.ipv4.conf.${FC_TAP}.proxy_arp=1 > /dev/null; \
  sysctl -w net.ipv6.conf.${FC_TAP}.disable_ipv6=1 > /dev/null"

ExecStart=/usr/local/bin/firecracker \
  --api-sock /run/iris-fc-${FC_AGENT_NAME}.socket \
  --config-file ${FC_CONFIG} \
  --log-path ${FC_LOG} \
  --level Info

ExecStopPost=/bin/bash -c "\
  ip link set ${FC_TAP} down 2>/dev/null || true; \
  ip tuntap del dev ${FC_TAP} mode tap 2>/dev/null || true"

StandardOutput=append:${FC_LOG}
StandardError=append:${FC_LOG}

[Install]
WantedBy=multi-user.target
UNIT

    sudo systemctl daemon-reload
    sudo systemctl enable "$FC_SERVICE"
    sudo systemctl restart "$FC_SERVICE"
    log "✓ ${FC_SERVICE} started"

  else
    # ── Terraform path (Azure backend) ───────────────────────────────
    [[ -z "$SA_NAME" ]] && die "SA_NAME is required for Firecracker + Azure path. Re-run with --setup."

    log "Creating Terraform state storage (${SA_NAME})..."
    az group create -n iris-tfstate-rg -l eastus -o none 2>/dev/null || true
    az storage account create \
      -n "$SA_NAME" -g iris-tfstate-rg \
      -l eastus --sku Standard_LRS \
      --min-tls-version TLS1_2 \
      --allow-blob-public-access false \
      -o none 2>/dev/null || true
    az storage container create \
      -n tfstate --account-name "$SA_NAME" --auth-mode login \
      -o none 2>/dev/null || true
    log "✓ Terraform state storage: ${SA_NAME}"

    log "Uncommenting module public_sandbox in agents.tf..."
    AGENTS_TF="${REPO_DIR}/terraform/agents.tf"
    python3 - "$AGENTS_TF" << 'PYEOF'
import sys, re
path = sys.argv[1]
with open(path) as f:
    txt = f.read()
if re.search(r'^module "public_sandbox"', txt, re.M):
    print("  already uncommented")
    sys.exit(0)
marker = 'Uncomment the block below'
idx = txt.rfind(marker)
if idx < 0:
    print("  marker not found — edit terraform/agents.tf manually")
    sys.exit(0)
start = txt.find('# module "public_sandbox"', idx)
end_brace = txt.find('# }', start)
end = txt.find('\n', end_brace) + 1
block = txt[start:end]
uncommented = re.sub(r'^# ?', '', block, flags=re.M)
with open(path, 'w') as f:
    f.write(txt[:start] + uncommented + txt[end:])
print("  ✓ uncommented")
PYEOF

    log "Running terraform init..."
    terraform -chdir="${REPO_DIR}/terraform" init \
      -backend-config="resource_group_name=iris-tfstate-rg" \
      -backend-config="storage_account_name=${SA_NAME}" \
      -backend-config="container_name=tfstate" \
      -backend-config="key=iris-dynamic.terraform.tfstate" \
      -backend-config="use_azuread_auth=true" \
      -reconfigure

    log "Running terraform apply..."
    TF_VAR_subscription_id="$SUBSCRIPTION_ID" \
      terraform -chdir="${REPO_DIR}/terraform" apply -auto-approve
    log "✓ Terraform apply complete"
  fi

  # ────────────────────────────────────────────────────────────
  # 12. Health check + switch iris.service to Firecracker
  # ────────────────────────────────────────────────────────────
  log_h "Firecracker health check"
  log "Waiting for VM at http://${FC_GUEST_IP}:8080/health (up to 20s)..."
  FC_HEALTHY=false
  for i in $(seq 1 20); do
    if curl -sf --max-time 2 "http://${FC_GUEST_IP}:8080/health" > /dev/null 2>&1; then
      log "✓ VM is healthy (${i}s)"
      FC_HEALTHY=true
      break
    fi
    sleep 1
  done

  if [[ "$FC_HEALTHY" == false ]]; then
    sudo journalctl -u iris-fc-public-sandbox -n 30 --no-pager || true
    die "VM did not respond after 20s — check logs above."
  fi

  log_h "Switching Iris to Firecracker sandbox"
  if [[ "$FIRECRACKER_SANDBOX" == "pool" ]]; then
    SANDBOX_FLAG="--sandbox=firecracker-pool"
  else
    SANDBOX_FLAG="--sandbox=firecracker:${FC_GUEST_IP}"
  fi

  sudo mkdir -p /etc/systemd/system/iris.service.d
  sudo tee /etc/systemd/system/iris.service.d/sandbox.conf > /dev/null << DROPIN
[Unit]
After=iris-fc-public-sandbox.service

[Service]
ExecStart=
ExecStart=${NODE_BIN} --require ${DOTENV_CONFIG} ${IRIS_RUNTIME_BIN} ${SANDBOX_FLAG} ${IRIS_DIR}/data
DROPIN

  sudo systemctl daemon-reload
  sudo systemctl restart iris
  sleep 2

  if ! sudo systemctl is-active --quiet iris; then
    sudo journalctl -u iris -n 30 --no-pager || true
    die "iris.service failed to restart in Firecracker mode — check logs above."
  fi
  log "✓ Iris switched to Firecracker mode (${SANDBOX_FLAG})"
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
if [[ "$NO_KEYVAULT" == false ]]; then
log "  Key Vault: ${KV_NAME}"
else
log "  Secrets:   /iris/.env  (edit and restart to update)"
fi
log "  Workspace: ${IRIS_DIR}"
log ""
if [[ -n "${SLACK_APP_TOKEN:-}" ]]; then
  log "  Slack:     @iris in any channel"
else
  log "  Slack:     not configured (add tokens to /iris/.env and restart)"
fi
if [[ "$FIRECRACKER_MODE" == true ]]; then
  log "  Firecracker: iris-fc-public-sandbox → ${FC_GUEST_IP}"
  log "  Sandbox:     ${SANDBOX_FLAG}"
  [[ "$NO_KEYVAULT" == false ]] && log "  Terraform:   iris-tfstate-rg / ${SA_NAME}"
  log "  VM logs:     journalctl -u iris-fc-public-sandbox -f"
  log "  Test:        @iris run: uname -a"
fi
log ""
