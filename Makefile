.PHONY: install dev dev-api build test lint typecheck check \
        up down logs restart clean deploy netmap-image netmap-ship help

# Compose reads `.env` from the project dir by default. Since the env files
# live under config/, point compose at them explicitly.
COMPOSE := docker compose --env-file config/.env

# ─── Local development ───────────────────────────────────────

install:
	pnpm install

## Frontend (Vite, :5173) + backend (tsx watch, :3000) together.
## Vite proxies /api and /router to the backend, so use :5173.
dev:
	pnpm dev

## Backend only, against the real config.
dev-api:
	pnpm --filter @homelab/backend dev

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

typecheck:
	pnpm typecheck

## Everything CI would run.
check: lint typecheck test build

# ─── Docker ──────────────────────────────────────────────────

## Dashboard only. The netmap sidecar is opt-in (see up-netmap).
up:
	$(COMPOSE) up -d --build

## Dashboard + netmap sidecar. Needs an image for THIS host's architecture:
## run `make netmap-image` on the target, or `make netmap-ship` from a
## machine of the same arch.
up-netmap:
	$(COMPOSE) --profile netmap up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

restart:
	$(COMPOSE) restart dashboard

clean:
	$(COMPOSE) down --rmi local -v

# ─── netmap sidecar ──────────────────────────────────────────
# netmap lives in its own repo. Its image is built here rather than by
# compose because a Rust release build on a small ARM board takes
# many minutes — build once on a fast machine, ship the image over SSH.

NETMAP_REPO ?= ../../netmap
NETMAP_TAG  ?= netmap:latest

## Build the netmap image locally from NETMAP_REPO.
netmap-image:
	@test -f "$(NETMAP_REPO)/Cargo.toml" || \
		{ echo "netmap repo not found at $(NETMAP_REPO) — override with NETMAP_REPO=..."; exit 1; }
	docker build -t $(NETMAP_TAG) "$(NETMAP_REPO)"
	@echo ">> Built $(NETMAP_TAG)"

## Copy the locally built image to DEPLOY_HOST (no registry needed).
netmap-ship: netmap-image
	@test -n "$(DEPLOY_HOST)" || { echo "DEPLOY_HOST is not set (pass DEPLOY_HOST=... or set it in config/deploy.mk)"; exit 1; }
	@echo ">> Shipping $(NETMAP_TAG) to $(DEPLOY_USER)@$(DEPLOY_HOST)"
	docker save $(NETMAP_TAG) | gzip | \
		$(SSH) $(DEPLOY_USER)@$(DEPLOY_HOST) 'gunzip | docker load'

# ─── Remote deploy ───────────────────────────────────────────

# Machine-specific defaults (DEPLOY_HOST=..., etc.) can live in the
# git-ignored config/deploy.mk instead of being passed every time.
-include config/deploy.mk

DEPLOY_HOST ?=
DEPLOY_USER ?= root
DEPLOY_PATH ?= /root/homelab-dashboard
DEPLOY_PORT ?= 1010
# Set to "--profile netmap" to also start the sidecar on the remote host.
COMPOSE_PROFILES ?=

# If SSHPASS is exported in the caller env, authenticate via sshpass;
# otherwise use plain ssh (key/agent).
ifdef SSHPASS
export SSHPASS
SSH       := sshpass -e ssh -o StrictHostKeyChecking=accept-new
RSYNC_RSH := sshpass -e ssh -o StrictHostKeyChecking=accept-new
else
SSH       := ssh -o StrictHostKeyChecking=accept-new
RSYNC_RSH := ssh -o StrictHostKeyChecking=accept-new
endif

## Rsync the project to DEPLOY_HOST and bring it up with docker compose.
## DASHBOARD_PORT is forced to DEPLOY_PORT via shell env (which wins over
## --env-file during compose interpolation), so the remote config/.env is
## not mutated. node_modules and build output are excluded — the remote
## image builds them itself.
deploy:
	@test -n "$(DEPLOY_HOST)" || { echo "DEPLOY_HOST is not set (pass DEPLOY_HOST=... or set it in config/deploy.mk)"; exit 1; }
	@echo ">> Deploying to $(DEPLOY_USER)@$(DEPLOY_HOST):$(DEPLOY_PATH) (port $(DEPLOY_PORT))"
	rsync -az --delete \
		--exclude='.git' --exclude='node_modules' --exclude='dist' \
		--exclude='config/backups' --exclude='config/icons' \
		-e '$(RSYNC_RSH)' ./ \
		$(DEPLOY_USER)@$(DEPLOY_HOST):$(DEPLOY_PATH)/
	$(SSH) $(DEPLOY_USER)@$(DEPLOY_HOST) \
		'set -e; cd $(DEPLOY_PATH) && DASHBOARD_PORT=$(DEPLOY_PORT) \
		docker compose --env-file config/.env $(COMPOSE_PROFILES) up -d --build'
	@echo ">> Done. http://$(DEPLOY_HOST):$(DEPLOY_PORT)/"

## Full deploy including the netmap sidecar image.
deploy-all: netmap-ship deploy

help:
	@grep -B1 -E '^[a-zA-Z0-9_-]+:' $(MAKEFILE_LIST) \
		| grep -A1 '^##' | sed 's/^## //' | paste -d'|' - - - \
		| awk -F'|' '{printf "  \033[36m%-16s\033[0m %s\n", $$2, $$1}' \
		| sed 's/:.*\x1b/\x1b/' || true
