#!/usr/bin/env bash
# Install Terraform and cloud CLIs on macOS (Homebrew).
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install from https://brew.sh"
  exit 1
fi

echo "Installing Terraform (HashiCorp tap)..."
brew tap hashicorp/tap
brew install hashicorp/tap/terraform

echo "Installing AWS CLI..."
brew install awscli

echo "Installing Google Cloud SDK..."
brew install --cask google-cloud-sdk

echo "Installing Linode CLI..."
brew install linode-cli

echo ""
echo "Done. Next steps:"
echo "  1. aws configure"
echo "  2. gcloud auth login && gcloud config set project YOUR_PROJECT_ID"
echo "  3. linode-cli configure   (or export LINODE_TOKEN=...)"
echo "  4. See infra/zixi/README.md for VM provisioning"
