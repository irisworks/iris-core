# ============================================================
# Terraform Remote State — Azure Storage
# ============================================================
# The storage account must exist BEFORE running terraform init.
# bootstrap.sh creates it automatically, or you can run:
#
#   az group create -n iris-tfstate-rg -l eastus
#   az storage account create \
#     -n <storage-account-name> -g iris-tfstate-rg \
#     -l eastus --sku Standard_LRS \
#     --min-tls-version TLS1_2 \
#     --allow-blob-public-access false
#   az storage container create \
#     -n tfstate --account-name <storage-account-name> \
#     --auth-mode login
#
# State key is iris-dynamic — separate from any bootstrap state
# so Iris cannot accidentally destroy her own host infrastructure.
#
# Override these values for your deployment:
#   export TF_BACKEND_RESOURCE_GROUP=my-tfstate-rg
#   export TF_BACKEND_STORAGE_ACCOUNT=myiristfstate
# ============================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  backend "azurerm" {
    # These must be set via -backend-config or environment variables:
    #   resource_group_name  = "iris-tfstate-rg"
    #   storage_account_name = "myiristfstate"
    #   container_name       = "tfstate"
    #   key                  = "iris-dynamic.terraform.tfstate"
    #   use_azuread_auth     = true
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "random" {}
