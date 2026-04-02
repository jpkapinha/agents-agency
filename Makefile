# =============================================================================
# agents-agency — Team-friendly shortcuts
#
# Quick start:
#   make init      # Create .env from template + project dirs
#   make start     # Launch the agency (Docker)
#   make logs      # Stream live logs
#   make stop      # Shut down
# =============================================================================

.PHONY: init start stop logs restart build reset costs status help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

init: ## First-time setup — create .env and project dirs
	@test -f .env || (cp .env.example .env && echo "Created .env from template — edit it with your API keys.")
	@test -f .env && echo ".env already exists — skipping copy." || true
	@mkdir -p secrets project-data
	@echo ""
	@echo "=== Setup Checklist ==="
	@echo "  1. Edit .env with your OPENROUTER_API_KEY and DISCORD_* values"
	@echo "  2. (Optional) Place SSH deploy key in secrets/git_deploy_key"
	@echo "  3. Run: make start"
	@echo ""

start: ## Launch the agency container
	docker compose up -d
	@echo "Agency starting... Run 'make logs' to watch."

stop: ## Shut down the agency
	docker compose down

logs: ## Stream live agency logs
	docker compose logs -f agency

restart: ## Restart the agency container
	docker compose restart agency

build: ## Rebuild the Docker image from scratch
	docker compose build --no-cache

reset: ## Full reset — remove container, volumes, and agency state
	docker compose down -v
	rm -rf project-data/.agency
	@echo "Agency state cleared. Run 'make start' to begin fresh."

costs: ## Show recent cost-tracker entries from logs
	@docker compose logs agency 2>&1 | grep cost-tracker | tail -20

status: ## Show container status
	docker compose ps
