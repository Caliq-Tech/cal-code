# Calcode: CLI (packages/opencode) + admin server (admin/)

.DEFAULT_GOAL := help
.PHONY: help setup install install-calcode install-admin admin-env \
        admin-migrate admin-migrate-dev admin-migrate-prod admin-dev admin-start admin-test admin-typecheck admin-reset-db \
        admin-check-deploy admin-deploy-dev admin-deploy-prod admin-encrypt-env-dev admin-encrypt-env-prod \
        calcode calcode-build calcode-install calcode-clean calcode-reinstall calcode-typecheck calcode-test test typecheck release

CLI_DIR   := packages/opencode
ADMIN_DIR := admin
BIN_DIR   ?= $(HOME)/.local/bin
ARGS      ?=
VERSION   ?=

help: ## Show this help
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}' $(MAKEFILE_LIST)

# ---- setup / install -------------------------------------------------------

setup: install admin-env admin-migrate ## Install deps, create admin/.env, run migrations

install: install-calcode install-admin ## Install dependencies for both projects

install-calcode: ## Install calcode (monorepo) dependencies
	bun install

install-admin: ## Install admin dependencies
	cd $(ADMIN_DIR) && bun install

admin-env: ## Create admin/.env from the example if missing
	@test -f $(ADMIN_DIR)/.env || (cp $(ADMIN_DIR)/.env.example $(ADMIN_DIR)/.env && \
	  echo "Created $(ADMIN_DIR)/.env - edit ADMIN_PASSWORD, ADMIN_SECRET and S3_* before running")

# ---- admin ----------------------------------------------------------------

admin-migrate: admin-env ## Apply pending admin database migrations
	cd $(ADMIN_DIR) && bun run migrate

admin-dev: admin-migrate ## Run admin server with auto-reload
	cd $(ADMIN_DIR) && bun run dev

admin-start: admin-migrate ## Run admin server (production)
	cd $(ADMIN_DIR) && bun run start

admin-test: ## Run admin tests
	cd $(ADMIN_DIR) && bun test

admin-typecheck: ## Typecheck admin
	cd $(ADMIN_DIR) && bun run typecheck

admin-reset-db: ## DROP the admin tables (users, providers, uploads) after asking
	@printf "Drop all calcode admin tables in the DATABASE_URL database? [y/N] " && read a && [ "$$a" = y ] \
	  && (cd $(ADMIN_DIR) && bun src/migrate.ts --reset) || echo "aborted"

# ---- admin: migrate a remote database from this machine --------------------

admin-migrate-dev: ## Apply pending migrations to the dev database
	cd $(ADMIN_DIR) && bun --env-file=.env.dev src/migrate.ts

admin-migrate-prod: ## Apply pending migrations to the prod database (asks first)
	@printf "Migrate the PROD database? [y/N] " && read a && [ "$$a" = y ] \
	  && (cd $(ADMIN_DIR) && bun --env-file=.env.prod src/migrate.ts) || echo "aborted"

# ---- admin: deploy to AWS Lambda (dev and prod) ----------------------------

AWS_PROFILE_NAME ?= caliq-sls-deploy
AWS_REGION       ?= ap-southeast-5
DEPLOYMENT_ID    ?= $(shell date +%s)
ENV_PASSPHRASE 	 ?= k8ydhdgatYehaV52tgS

-include make-local.mk

export USE_AWS_PROFILE := true
export AWS_PROFILE_NAME
export AWS_REGION
export ENV_PASSPHRASE
export DEPLOYMENT_ID

admin-check-deploy:
	@test -n "$(ENV_PASSPHRASE)" || { echo "ERROR: ENV_PASSPHRASE is not set. Run: make $(MAKECMDGOALS) ENV_PASSPHRASE=... (or save it in make-local.mk)"; exit 1; }
	@for t in aws gpg zip unzip curl python3 bun; do command -v $$t >/dev/null || { echo "ERROR: $$t is required"; exit 1; }; done

admin-deploy-dev: admin-check-deploy ## Deploy admin to Lambda (dev)
	$(ADMIN_DIR)/scripts/deployment-api-lambda.sh dev

admin-deploy-prod: admin-check-deploy ## Deploy admin to Lambda (prod; use AWS_REGION=ap-southeast-1)
	$(ADMIN_DIR)/scripts/deployment-api-lambda.sh prod

admin-encrypt-env-dev: admin-check-deploy ## Encrypt admin/.env.dev -> admin/.env.dev.gpg
	gpg --batch --yes --passphrase "$(ENV_PASSPHRASE)" --symmetric --cipher-algo AES256 $(ADMIN_DIR)/.env.dev

admin-encrypt-env-prod: admin-check-deploy ## Encrypt admin/.env.prod -> admin/.env.prod.gpg
	gpg --batch --yes --passphrase "$(ENV_PASSPHRASE)" --symmetric --cipher-algo AES256 $(ADMIN_DIR)/.env.prod

# ---- calcode CLI ----------------------------------------------------------

calcode: ## Run the CLI from source: make calcode ARGS="run hi"
	cd $(CLI_DIR) && bun run ./src/index.ts $(ARGS)

calcode-build: ## Build a native binary for this machine
	cd $(CLI_DIR) && bun run script/build.ts --single --skip-install

calcode-install: calcode-build ## Build and link the binary as `calcode` into ~/.local/bin
	@bin=$$(ls -d $(CURDIR)/$(CLI_DIR)/dist/*/bin/opencode 2>/dev/null | head -1); \
	  test -n "$$bin" || { echo "no built binary found"; exit 1; }; \
	  mkdir -p $(BIN_DIR) && ln -sf "$$bin" $(BIN_DIR)/calcode && \
	  echo "linked $(BIN_DIR)/calcode -> $$bin" && \
	  case ":$$PATH:" in *":$(BIN_DIR):"*) ;; *) echo "note: add $(BIN_DIR) to your PATH";; esac

calcode-clean: ## Remove local calcode/opencode config, data and cache
	rm -rf ~/.config/opencode ~/.config/calcode ~/.local/share/opencode ~/.local/share/calcode ~/.cache/opencode

calcode-reinstall: calcode-clean calcode-install ## Wipe local state, then rebuild and relink the binary

# Build every platform locally, tag + push to git, and upload the binaries to a GitHub Release

GH_REPO ?= $(shell git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$$||')

ENV ?= dev

release: ## Build all platforms, push tag v$(VERSION), create the GitHub Release and upload binaries (ENV=dev|prod, default dev)
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make $@ VERSION=1.0.0"; exit 1; }
	@test -f .env.$(ENV) || { echo ".env.$(ENV) not found (ENV must be dev or prod)"; exit 1; }
	cp .env.$(ENV) .env
	@test -z "$$(git status --porcelain)" || { echo "working tree is dirty: commit or stash first"; exit 1; }
	git push origin HEAD
	git rev-parse -q --verify refs/tags/v$(VERSION) >/dev/null || git tag v$(VERSION)
	git push origin v$(VERSION)
	gh release view v$(VERSION) --repo $(GH_REPO) >/dev/null 2>&1 || \
	  gh release create v$(VERSION) --repo $(GH_REPO) --verify-tag --title "v$(VERSION)" --generate-notes
	cd $(CLI_DIR) && OPENCODE_VERSION=$(VERSION) OPENCODE_CHANNEL=latest OPENCODE_RELEASE=1 GH_REPO=$(GH_REPO) bun run script/build.ts
	@echo "Released v$(VERSION). Install: curl -fsSL https://raw.githubusercontent.com/$(GH_REPO)/master/install | bash"

calcode-typecheck: ## Typecheck calcode
	cd $(CLI_DIR) && bun typecheck

calcode-test: ## Run calcode audit tests
	cd $(CLI_DIR) && bun test test/audit --timeout 30000

# ---- both -----------------------------------------------------------------

test: calcode-test admin-test ## Run calcode audit tests + admin tests

typecheck: calcode-typecheck admin-typecheck ## Typecheck both projects
