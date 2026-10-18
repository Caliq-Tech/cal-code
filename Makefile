# Calcode: CLI (packages/opencode) + admin server (admin/)
#   make setup        first-time: install everything, create admin/.env, run migrations
#   make admin-dev    start the admin server with reload     (http://localhost:8787)
#   make calcode ARGS="run hi"   run the CLI from source
.DEFAULT_GOAL := help
.PHONY: help setup install install-calcode install-admin admin-env \
        admin-migrate admin-dev admin-start admin-test admin-typecheck admin-reset-db \
        calcode calcode-build calcode-install calcode-typecheck calcode-test test typecheck \
        calcode-build-all calcode-publish-dry calcode-publish calcode-publish-only calcode-deploy

CLI_DIR   := packages/opencode
ADMIN_DIR := admin
BIN_DIR   ?= $(HOME)/.local/bin
ARGS      ?=
VERSION   ?=
CHANNEL   ?= latest

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

# Publishing to npm: `calcode` + calcode-<os>-<arch> packages. Requires `npm login`.
#   make calcode-publish-dry VERSION=1.0.0    build everything and run `npm publish --dry-run`
#   make calcode-publish VERSION=1.0.0        publish for real (CHANNEL=latest by default)
# Versions can't be republished, so bump VERSION each release.
calcode-build-all: ## Build binaries for all platforms (needs VERSION=x.y.z)
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make $@ VERSION=1.0.0"; exit 1; }
	cd $(CLI_DIR) && OPENCODE_VERSION=$(VERSION) OPENCODE_CHANNEL=$(CHANNEL) bun run script/build.ts

calcode-publish-dry: calcode-build-all ## Dry-run the npm publish (nothing is uploaded)
	@npm whoami >/dev/null || { echo "not logged in: run npm login"; exit 1; }
	cd $(CLI_DIR) && DRY_RUN=1 OPENCODE_VERSION=$(VERSION) OPENCODE_CHANNEL=$(CHANNEL) bun run script/publish.ts

calcode-publish: calcode-build-all calcode-publish-only ## Build all platforms and publish to npm (needs VERSION=x.y.z)

calcode-publish-only: ## Publish the existing dist/ without rebuilding (resume after a failure)
	@test -n "$(VERSION)" || { echo "VERSION is required"; exit 1; }
	@npm whoami >/dev/null || { echo "not logged in: run npm login"; exit 1; }
	cd $(CLI_DIR) && OPENCODE_VERSION=$(VERSION) OPENCODE_CHANNEL=$(CHANNEL) bun run script/publish.ts

calcode-deploy: ## One-go publish via local ./deployment.sh (not in git): make calcode-deploy VERSION=x.y.z
	@test -x deployment.sh || { echo "deployment.sh not found (it is local-only and gitignored)"; exit 1; }
	./deployment.sh $(VERSION)

calcode-typecheck: ## Typecheck calcode
	cd $(CLI_DIR) && bun typecheck

calcode-test: ## Run calcode audit tests
	cd $(CLI_DIR) && bun test test/audit --timeout 30000

# ---- both -----------------------------------------------------------------

test: calcode-test admin-test ## Run calcode audit tests + admin tests

typecheck: calcode-typecheck admin-typecheck ## Typecheck both projects
