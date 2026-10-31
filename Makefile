LAYER ?=
COMPOSE_FILES := $(foreach f,$(sort $(wildcard layers/*/compose.yml)),-f $(f))
need_layer = $(if $(LAYER),,$(error LAYER is required, e.g. make $(1) LAYER=l3-knowledge))

.PHONY: up down test up-all down-all

up:
	$(call need_layer,up)
	docker compose -f layers/$(LAYER)/compose.yml --env-file .env up -d --wait

down:
	$(call need_layer,down)
	docker compose -f layers/$(LAYER)/compose.yml --env-file .env down

test:
	$(call need_layer,test)
	LAYER=$(LAYER) npm run --silent test:layer

up-all:
	docker compose $(COMPOSE_FILES) --env-file .env up -d --wait

down-all:
	docker compose $(COMPOSE_FILES) --env-file .env down
