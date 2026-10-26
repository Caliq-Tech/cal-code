#!/bin/bash
#
# calcode-admin ZIP deployment to AWS Lambda (no Docker).
# Usage: ./scripts/deployment-api-lambda.sh <dev|prod>   (run from anywhere)
#
# Local:   ENV_PASSPHRASE=... ./scripts/deployment-api-lambda.sh dev     (or: make admin-deploy-dev)
# CI:      USE_AWS_PROFILE=false ENV_PASSPHRASE=... DEPLOYMENT_ID=<sha> ./scripts/deployment-api-lambda.sh dev
#
# The admin server is Bun code, which Lambda has no managed runtime for. It ships as a
# custom runtime (provided.al2023): the zip holds the bun binary, src/, public/, migrations/,
# production node_modules, the decrypted env as .env, and `bootstrap` (starts src/lambda.ts).
#
# Deploys ONE function: calcode-admin-<env> (created once outside this script, with an
# API Gateway HTTP API / Function URL in front and network access to Postgres).

set -euo pipefail

export AWS_PAGER=""

# ============================================================
# FUNCTION SPEC (edit per function, nothing else below)
# ============================================================
FUNCTION_BASE="${FUNCTION_BASE:-calcode-admin}"
HANDLER="bootstrap"
TIMEOUT=30
MEMORY=512

RUNTIME="provided.al2023"
ALIAS="live"
BUN_VERSION="${BUN_VERSION:-1.4.2}"

# ============================================================
# ENVIRONMENT ARGUMENT
# ============================================================

cd "$(dirname "$0")/.."

SUFFIX="${1:?Usage: $0 <dev|prod>}"

case "$SUFFIX" in
  dev)  STAGE="development"; ENV_FILE=".env.dev.gpg" ;;
  prod) STAGE="production";  ENV_FILE=".env.prod.gpg" ;;
  *) echo "ERROR: unknown env '$SUFFIX'. Use dev|prod."; exit 1 ;;
esac

FUNCTION="${FUNCTION_BASE}-${SUFFIX}"
REGION="${AWS_REGION:-ap-southeast-5}"

# Bucket follows the region (override with S3_BUCKET=... if needed)
if [ -z "${S3_BUCKET:-}" ]; then
  case "$REGION" in
    ap-southeast-1) S3_BUCKET="caliq-lambda-production-bucket" ;;
    ap-southeast-5) S3_BUCKET="caliq-lambda-development-bucket" ;;
    *)
      echo "ERROR: no bucket mapped for region '$REGION'."
      echo "Set AWS_REGION to ap-southeast-5 (dev) or ap-southeast-1 (prod), or export S3_BUCKET explicitly."
      exit 1
      ;;
  esac
fi

# ============================================================
# AWS PROFILE CONFIGURATION
# ============================================================
# Local:  USE_AWS_PROFILE defaults to true  -> uses --profile "$PROFILE"
# CI:     USE_AWS_PROFILE=false             -> uses OIDC / env credentials
USE_AWS_PROFILE="${USE_AWS_PROFILE:-true}"
PROFILE="${AWS_PROFILE_NAME:-qatarat-sls-deploy}"

AWS_ARGS=()

if [ "$USE_AWS_PROFILE" = "true" ]; then
  AWS_ARGS+=(--profile "$PROFILE")
  export AWS_PROFILE="$PROFILE"
fi

# Use provided DEPLOYMENT_ID or generate one locally
export DEPLOYMENT_ID="${DEPLOYMENT_ID:-$(date +%s)}"

if [ -z "${ENV_PASSPHRASE:-}" ]; then
  echo "ERROR: ENV_PASSPHRASE is not set (needed to decrypt $ENV_FILE)."
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found in admin/."
  echo "Create admin/.env.${SUFFIX} (see .env.example) and run: make admin-encrypt-env-${SUFFIX}"
  exit 1
fi

echo "========================================"
echo "Deploying ${FUNCTION} (ZIP, no Docker)"
echo "========================================"
echo "Stage                : ${STAGE} (${SUFFIX})"
echo "Runtime / Handler    : ${RUNTIME} / ${HANDLER} (bun ${BUN_VERSION})"
echo "Timeout / Memory     : ${TIMEOUT}s / ${MEMORY}MB"
echo "AWS Profile enabled  : ${USE_AWS_PROFILE}"
if [ "$USE_AWS_PROFILE" = "true" ]; then
  echo "AWS Profile          : ${PROFILE}"
fi
echo "Deployment ID        : ${DEPLOYMENT_ID}"
echo "Region               : ${REGION}"
echo "S3 Bucket            : ${S3_BUCKET}"
echo "========================================"

# ============================================================
# VERIFY AWS IDENTITY
# ============================================================

echo ""
echo "Checking AWS identity..."

aws "${AWS_ARGS[@]}" sts get-caller-identity

# ============================================================
# RESOLVE ARCHITECTURE (bun binary must match the function)
# ============================================================

LAMBDA_ARCH=$(aws "${AWS_ARGS[@]}" lambda get-function-configuration \
  --function-name "$FUNCTION" \
  --region "$REGION" \
  --query 'Architectures[0]' \
  --output text)

case "$LAMBDA_ARCH" in
  x86_64) BUN_ARCH="x64" ;;
  arm64)  BUN_ARCH="aarch64" ;;
  *) echo "ERROR: unsupported Lambda architecture '$LAMBDA_ARCH'."; exit 1 ;;
esac

# ============================================================
# BUILD PACKAGE DIRECTORY
# Staged outside the working tree so local node_modules/.env are untouched.
# ============================================================

BUILD_DIR=$(mktemp -d)
ZIP="$BUILD_DIR/lambda.zip"
PKG="$BUILD_DIR/pkg"

# Always remove the decrypted secret, even on failure
cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

mkdir -p "$PKG"

echo ""
echo "Fetching bun ${BUN_VERSION} (linux-${BUN_ARCH})..."

CACHE_DIR=".lambda-cache"
BUN_ZIP="$CACHE_DIR/bun-${BUN_VERSION}-linux-${BUN_ARCH}.zip"
mkdir -p "$CACHE_DIR"
if [ ! -f "$BUN_ZIP" ]; then
  curl -fsSL -o "$BUN_ZIP" \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip"
fi
unzip -qj "$BUN_ZIP" "bun-linux-${BUN_ARCH}/bun" -d "$PKG"
chmod +x "$PKG/bun"

echo ""
echo "Installing production dependencies..."

cp package.json bun.lock "$PKG/"
(cd "$PKG" && bun install --production --frozen-lockfile)
find "$PKG/node_modules" -type f -name '*.map' -delete

cp -R src public migrations "$PKG/"
cp bootstrap "$PKG/bootstrap"
chmod +x "$PKG/bootstrap"

echo ""
echo "Decrypting $ENV_FILE -> .env..."

gpg --quiet --batch --yes \
  --passphrase="${ENV_PASSPHRASE}" --output "$PKG/.env" --decrypt "$ENV_FILE"

# ============================================================
# CREATE DEPLOYMENT PACKAGE
# ============================================================

echo ""
echo "Creating deployment package..."

(cd "$PKG" && zip -qr "$ZIP" .)

echo ""
echo "Package created:"
ls -lh "$ZIP"

# ============================================================
# S3 KEY
# ============================================================

S3_KEY="lambda/${FUNCTION}/${DEPLOYMENT_ID}.zip"

echo ""
echo "Uploading package to S3..."
echo "s3://${S3_BUCKET}/${S3_KEY}"

aws "${AWS_ARGS[@]}" s3 cp \
  "$ZIP" \
  "s3://${S3_BUCKET}/${S3_KEY}" \
  --region "$REGION"

# ============================================================
# UPDATE LAMBDA CONFIGURATION (runtime/handler/timeout/memory + env)
# Merges NODE_ENV/DEPLOYMENT_ID into the existing variables. App settings live in
# the baked .env; Lambda env is only for the deploy marker.
# ============================================================

echo ""
echo "Updating Lambda configuration..."

CURRENT_VARS_JSON=$(aws "${AWS_ARGS[@]}" lambda get-function-configuration \
  --function-name "$FUNCTION" \
  --region "$REGION" \
  --query 'Environment.Variables' \
  --output json) || CURRENT_VARS_JSON="null"

ENV_JSON=$(printf '%s' "$CURRENT_VARS_JSON" \
  | STAGE="$STAGE" DEPLOYMENT_ID="$DEPLOYMENT_ID" python3 -c '
import json, os, sys
try:
    cur = json.load(sys.stdin)
except Exception:
    cur = {}
if not isinstance(cur, dict):
    cur = {}
cur["NODE_ENV"] = os.environ["STAGE"]
cur["DEPLOYMENT_ID"] = os.environ["DEPLOYMENT_ID"]
print(json.dumps({"Variables": cur}))
')

aws "${AWS_ARGS[@]}" lambda update-function-configuration \
  --function-name "$FUNCTION" \
  --runtime "$RUNTIME" \
  --handler "$HANDLER" \
  --timeout "$TIMEOUT" \
  --memory-size "$MEMORY" \
  --environment "$ENV_JSON" \
  --region "$REGION" \
  >/dev/null

# ============================================================
# WAIT FOR CONFIGURATION UPDATE
# ============================================================

wait_for_update() {
  while true; do

    UPDATE_STATUS=$(aws "${AWS_ARGS[@]}" lambda get-function-configuration \
      --function-name "$FUNCTION" \
      --region "$REGION" \
      --query 'LastUpdateStatus' \
      --output text)

    echo "Lambda update status: $UPDATE_STATUS"

    if [ "$UPDATE_STATUS" = "Successful" ]; then
      return 0
    fi

    if [ "$UPDATE_STATUS" = "Failed" ]; then

      echo ""
      echo "ERROR: Lambda update failed."

      aws "${AWS_ARGS[@]}" lambda get-function-configuration \
        --function-name "$FUNCTION" \
        --region "$REGION" \
        --query '{Status:LastUpdateStatus,Reason:LastUpdateStatusReason,ReasonCode:LastUpdateStatusReasonCode}' \
        --output table

      exit 1
    fi

    sleep 5

  done
}

echo ""
echo "Waiting for Lambda configuration update..."
wait_for_update
echo "Lambda configuration update completed successfully."

# ============================================================
# UPDATE LAMBDA CODE
# ============================================================

echo ""
echo "Updating Lambda code from S3..."

aws "${AWS_ARGS[@]}" lambda update-function-code \
  --function-name "$FUNCTION" \
  --s3-bucket "$S3_BUCKET" \
  --s3-key "$S3_KEY" \
  --region "$REGION" \
  >/dev/null

# Publishing needs the code update to finish first.
wait_for_update

echo ""
echo "Publishing new version..."

VERSION=$(aws "${AWS_ARGS[@]}" lambda publish-version \
  --function-name "$FUNCTION" \
  --description "$DEPLOYMENT_ID" \
  --region "$REGION" \
  --query 'Version' \
  --output text)

if [ -z "$VERSION" ] || [ "$VERSION" = "\$LATEST" ]; then
  echo "ERROR: Could not get newly published Lambda version."
  exit 1
fi

echo ""
echo "New Lambda version: $VERSION"

# ============================================================
# CHECK / CREATE / UPDATE ALIAS
# ============================================================

echo ""
echo "Checking alias '$ALIAS'..."

if aws "${AWS_ARGS[@]}" lambda get-alias \
  --function-name "$FUNCTION" \
  --name "$ALIAS" \
  --region "$REGION" \
  >/dev/null 2>&1
then

  CURRENT_VERSION=$(aws "${AWS_ARGS[@]}" lambda get-alias \
    --function-name "$FUNCTION" \
    --name "$ALIAS" \
    --region "$REGION" \
    --query 'FunctionVersion' \
    --output text)

  echo "Current alias version: $CURRENT_VERSION"
  echo "Updating alias to version: $VERSION"

  aws "${AWS_ARGS[@]}" lambda update-alias \
    --function-name "$FUNCTION" \
    --name "$ALIAS" \
    --function-version "$VERSION" \
    --region "$REGION" \
    >/dev/null

else

  echo "Alias '$ALIAS' does not exist."
  echo "Creating alias -> version $VERSION"

  aws "${AWS_ARGS[@]}" lambda create-alias \
    --function-name "$FUNCTION" \
    --name "$ALIAS" \
    --function-version "$VERSION" \
    --region "$REGION" \
    >/dev/null

fi

# ============================================================
# VERIFY ALIAS
# ============================================================

echo ""
echo "Verifying alias..."

FINAL_VERSION=$(aws "${AWS_ARGS[@]}" lambda get-alias \
  --function-name "$FUNCTION" \
  --name "$ALIAS" \
  --region "$REGION" \
  --query 'FunctionVersion' \
  --output text)

if [ "$FINAL_VERSION" != "$VERSION" ]; then

  echo ""
  echo "ERROR: Alias verification failed!"
  echo "Expected: $VERSION"
  echo "Actual:   $FINAL_VERSION"

  exit 1
fi

# ============================================================
# SUCCESS
# ============================================================

echo ""
echo "========================================"
echo "Deployment completed successfully"
echo "========================================"
echo "Function : $FUNCTION"
echo "Runtime  : $RUNTIME"
echo "Version  : $VERSION"
echo "Alias    : $ALIAS"
echo "Points   : $FINAL_VERSION"
echo "S3 Key   : $S3_KEY"
echo "========================================"
