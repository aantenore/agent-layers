# Layer id of a reference setup: the folder name under reference/ (infra, llm, knowledge, tool, ...).
# The old numbered folder names are not accepted any more: layer numbers changed meaning.
LAYER ?=
# Deploy target for infra-up / infra-down: compose (default), k8s, or your own (see docs/layers/infra.md).
TARGET ?= compose

# The infra compose file is the infra target (Traefik, OpenBao), started with infra-up, not a layer in up-all.
COMPOSE_FILES := $(foreach f,$(filter-out reference/infra/compose.yml,$(sort $(wildcard reference/*/compose.yml))),-f $(f))
need_layer = $(if $(LAYER),,$(error LAYER is required, e.g. make $(1) LAYER=knowledge))$(if $(wildcard reference/$(LAYER)),,$(error no reference setup "$(LAYER)": use a layer id, one of: $(notdir $(wildcard reference/*))))

# Tool images are pinned here and nowhere else: CI and local runs use the same ones.
HELM_IMAGE ?= alpine/helm:3.22.1
TOFU_IMAGE ?= ghcr.io/opentofu/opentofu:1.13.5
INFRA_DIR := reference/infra
INFRA_COMPOSE := docker compose -f $(INFRA_DIR)/compose.yml $(if $(wildcard .env),--env-file .env)
# Output file for env-from-openbao; add FORCE=1 to overwrite.
OUT ?= .env

# Extra targets: drop a *.mk defining infra-up-<name> and infra-down-<name> here.
-include $(wildcard $(INFRA_DIR)/targets/*.mk)

.PHONY: up down test up-all down-all \
	infra-up infra-down infra-up-compose infra-down-compose infra-up-k8s infra-down-k8s \
	secrets-seed env-from-openbao helm-lint helm-template tofu-validate \
	docs-check docs-adapters

up:
	$(call need_layer,up)
	docker compose -f reference/$(LAYER)/compose.yml --env-file .env up -d --wait

down:
	$(call need_layer,down)
	docker compose -f reference/$(LAYER)/compose.yml --env-file .env down

test:
	$(call need_layer,test)
	LAYER=$(LAYER) npm run --silent test:layer

up-all:
	docker compose $(COMPOSE_FILES) --env-file .env up -d --wait

down-all:
	docker compose $(COMPOSE_FILES) --env-file .env down

# --- infra ------------------------------------------------------------------------------------------------

infra-up:
	@$(MAKE) --no-print-directory infra-up-$(TARGET)

infra-down:
	@$(MAKE) --no-print-directory infra-down-$(TARGET)

infra-up-compose:
	$(INFRA_COMPOSE) up -d --wait

infra-down-compose:
	$(INFRA_COMPOSE) down -v

# GitOps: Argo CD syncs the Helm chart from the repository. Needs kubectl pointed at the cluster.
infra-up-k8s:
	kubectl apply -f $(INFRA_DIR)/argocd/application.yaml

infra-down-k8s:
	kubectl delete -f $(INFRA_DIR)/argocd/application.yaml

secrets-seed:
	bash $(INFRA_DIR)/scripts/seed-secrets.sh

env-from-openbao:
	bash $(INFRA_DIR)/scripts/env-from-openbao.sh -o $(OUT) $(if $(FORCE),-f)

helm-lint:
	docker run --rm -v "$(CURDIR)/$(INFRA_DIR)/helm:/work" -w /work $(HELM_IMAGE) lint agent-layers -f agent-layers/ci/all-enabled.yaml

helm-template: helm-lint
	docker run --rm -v "$(CURDIR)/$(INFRA_DIR)/helm:/work" -w /work $(HELM_IMAGE) template agent-layers agent-layers -f agent-layers/ci/all-enabled.yaml > /dev/null
	@echo "helm template: ok"

# --- docs -------------------------------------------------------------------------------------------------

docs-check:
	node scripts/check-docs.mjs

docs-adapters:
	node scripts/gen-adapters-catalog.mjs

# fmt check, then init without a backend and validate every module and example.
tofu-validate:
	docker run --rm -v "$(CURDIR)/$(INFRA_DIR)/opentofu:/work" -w /work $(TOFU_IMAGE) fmt -check -recursive
	@for dir in modules/docker-host modules/k8s-cluster examples/hetzner-docker-host; do \
		echo "tofu validate $$dir"; \
		docker run --rm -v "$(CURDIR)/$(INFRA_DIR)/opentofu:/work" -w /work/$$dir $(TOFU_IMAGE) init -backend=false -input=false -no-color > /dev/null \
		&& docker run --rm -v "$(CURDIR)/$(INFRA_DIR)/opentofu:/work" -w /work/$$dir $(TOFU_IMAGE) validate -no-color || exit 1; \
	done
