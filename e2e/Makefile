# E2E Testing Makefile
# 
# Common operations for running E2E tests locally and in CI
#

.PHONY: help setup setup-minikube build-images build-test-containers load-images load-test-containers test test-phase-1 test-phase-2 test-phase-3 test-ci cleanup report logs

# Default values
TEST_PHASE ?= all
DEBUG ?= false
CI_MODE ?= false
MINIKUBE_DRIVER ?= docker
MINIKUBE_MEMORY ?= 4096
MINIKUBE_CPUS ?= 2
KUBERNETES_VERSION ?= v1.29.0

# Directories
E2E_DIR := $(CURDIR)
CI_DIR := $(E2E_DIR)/ci
PROJECT_ROOT := $(E2E_DIR)/..
RESULTS_DIR := $(E2E_DIR)/results

# Docker images
ORCHESTRATOR_IMAGE := nanoclaw-orchestrator:latest
AGENT_IMAGE := nanoclaw-agent:latest
FILE_ADAPTER_IMAGE := nanoclaw-file-adapter:latest
HTTP_ADAPTER_IMAGE := nanoclaw-http-adapter:latest
TEST_FILE_ECHO_IMAGE := nanoclaw-test-file-echo:latest
TEST_HTTP_ECHO_IMAGE := nanoclaw-test-http-echo:latest

# Colors for output
GREEN := \033[0;32m
YELLOW := \033[1;33m
RED := \033[0;31m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "E2E Testing Makefile"
	@echo ""
	@echo "Usage: make [target] [options]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "Options:"
	@echo "  TEST_PHASE=[all|phase-1|phase-2|phase-3]  Which test phase to run (default: all)"
	@echo "  DEBUG=true|false                         Enable debug mode (default: false)"
	@echo "  CI_MODE=true|false                       Run in CI mode (default: false)"

setup: setup-minikube build-images ## Setup complete test environment

setup-minikube: ## Setup minikube cluster
	@echo "$(GREEN)Setting up minikube...$(NC)"
	@if ! command -v minikube &> /dev/null; then \
		echo "$(YELLOW)Installing minikube...$(NC)"; \
		curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64; \
		sudo install minikube-linux-amd64 /usr/local/bin/minikube; \
		rm minikube-linux-amd64; \
	fi
	@if ! minikube status &> /dev/null; then \
		echo "$(GREEN)Starting minikube...$(NC)"; \
		minikube start \
			--driver=$(MINIKUBE_DRIVER) \
			--memory=$(MINIKUBE_MEMORY) \
			--cpus=$(MINIKUBE_CPUS) \
			--kubernetes-version=$(KUBERNETES_VERSION) \
			--wait=all; \
	else \
		echo "$(GREEN)Minikube is already running$(NC)"; \
	fi
	@kubectl config use-context minikube || true
	@echo "$(GREEN)Minikube setup complete$(NC)"

build-images: ## Build Docker images for testing
	@echo "$(GREEN)Building Docker images...$(NC)"
	@cd $(PROJECT_ROOT) && docker build -t $(ORCHESTRATOR_IMAGE) .
	@cd $(PROJECT_ROOT)/container && docker build -f Dockerfile -t $(AGENT_IMAGE) ..
	@echo "$(GREEN)Images built:$(NC)"
	@docker images --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}" | grep nanoclaw || true

load-images: ## Load images into minikube
	@echo "$(GREEN)Loading images into minikube...$(NC)"
	@minikube image load $(ORCHESTRATOR_IMAGE)
	@minikube image load $(AGENT_IMAGE)
	@echo "$(GREEN)Images loaded$(NC)"

build-test-containers: ## Build test container images for sidecar e2e tests
	@echo "$(GREEN)Building test container images...$(NC)"
	@cd $(E2E_DIR)/test-containers/file-echo && docker build -t $(TEST_FILE_ECHO_IMAGE) .
	@cd $(E2E_DIR)/test-containers/http-echo && docker build -t $(TEST_HTTP_ECHO_IMAGE) .
	@echo "$(GREEN)Test images built:$(NC)"
	@docker images --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}" | grep nanoclaw-test || true

load-test-containers: ## Load test container images into minikube
	@echo "$(GREEN)Loading test images into minikube...$(NC)"
	@minikube image load $(TEST_FILE_ECHO_IMAGE)
	@minikube image load $(TEST_HTTP_ECHO_IMAGE)
	@echo "$(GREEN)Test images loaded$(NC)"

deploy-k8s: ## Deploy to Kubernetes
	@echo "$(GREEN)Deploying to Kubernetes...$(NC)"
	@kubectl create namespace nanoclaw 2>/dev/null || true
	@kubectl apply -f $(PROJECT_ROOT)/k8s/00-namespace.yaml || true
	@kubectl apply -f $(PROJECT_ROOT)/k8s/10-redis.yaml
	@kubectl apply -f $(PROJECT_ROOT)/k8s/20-storage.yaml
	@kubectl apply -f $(PROJECT_ROOT)/k8s/30-orchestrator.yaml
	@kubectl apply -f $(PROJECT_ROOT)/k8s/40-agent-job-template.yaml
	@kubectl apply -f $(PROJECT_ROOT)/k8s/01-network-policy.yaml || true
	@echo "$(GREEN)Waiting for Redis...$(NC)"
	@kubectl wait --namespace=nanoclaw --for=condition=ready pod -l app=nanoclaw-redis --timeout=120s
	@echo "$(GREEN)Waiting for orchestrator...$(NC)"
	@kubectl wait --namespace=nanoclaw --for=condition=available deployment/nanoclaw-orchestrator --timeout=180s || true
	@echo "$(GREEN)Deployment complete$(NC)"

test: ## Run all E2E tests
	@make test-phase-1
	@make test-phase-2
	@make test-phase-3

test-phase-1: setup ## Run Phase 1: Infrastructure tests
	@echo "$(GREEN)Running Phase 1: Infrastructure tests$(NC)"
	@mkdir -p $(RESULTS_DIR)
	@cd $(PROJECT_ROOT) && TEST_PHASE=phase-1 npm run test:e2e:phase-1 -- --reporter=json --outputFile=$(RESULTS_DIR)/phase-1.json || true
	@node $(CI_DIR)/test-reporter.js --input=$(RESULTS_DIR)/phase-1.json --output=$(RESULTS_DIR)/phase-1-junit.xml --summary=$(RESULTS_DIR)/phase-1-summary.md || true

test-phase-2: setup ## Run Phase 2: Integration tests
	@echo "$(GREEN)Running Phase 2: Integration tests$(NC)"
	@mkdir -p $(RESULTS_DIR)
	@cd $(PROJECT_ROOT) && TEST_PHASE=phase-2 npm run test:e2e:phase-2 -- --reporter=json --outputFile=$(RESULTS_DIR)/phase-2.json || true
	@node $(CI_DIR)/test-reporter.js --input=$(RESULTS_DIR)/phase-2.json --output=$(RESULTS_DIR)/phase-2-junit.xml --summary=$(RESULTS_DIR)/phase-2-summary.md || true

test-phase-3: setup ## Run Phase 3: End-to-end tests
	@echo "$(GREEN)Running Phase 3: End-to-end tests$(NC)"
	@mkdir -p $(RESULTS_DIR)
	@cd $(PROJECT_ROOT) && TEST_PHASE=phase-3 npm run test:e2e:phase-3 -- --reporter=json --outputFile=$(RESULTS_DIR)/phase-3.json || true
	@node $(CI_DIR)/test-reporter.js --input=$(RESULTS_DIR)/phase-3.json --output=$(RESULTS_DIR)/phase-3-junit.xml --summary=$(RESULTS_DIR)/phase-3-summary.md || true

test-ci: ## Run tests in CI mode (Docker)
	@echo "$(GREEN)Running tests in CI mode...$(NC)"
	@chmod +x $(CI_DIR)/run-in-docker.sh
	@TEST_PHASE=$(TEST_PHASE) DEBUG=$(DEBUG) $(CI_DIR)/run-in-docker.sh

report: ## Generate test report from results
	@echo "$(GREEN)Generating test report...$(NC)"
	@if [ -d "$(RESULTS_DIR)" ]; then \
		node $(CI_DIR)/test-reporter.js \
			--combine \
			--input=$(RESULTS_DIR) \
			--output=$(RESULTS_DIR)/combined-junit.xml \
			--summary=$(RESULTS_DIR)/combined-summary.md; \
	else \
		echo "$(YELLOW)No results directory found$(NC)"; \
	fi

logs: ## Show Kubernetes logs
	@echo "$(GREEN)Kubernetes Logs:$(NC)"
	@echo "--- Orchestrator ---"
	@kubectl logs --namespace=nanoclaw -l app=nanoclaw-orchestrator --tail=50 2>/dev/null || echo "$(YELLOW)No orchestrator logs found$(NC)"
	@echo ""
	@echo "--- Redis ---"
	@kubectl logs --namespace=nanoclaw -l app=nanoclaw-redis --tail=50 2>/dev/null || echo "$(YELLOW)No Redis logs found$(NC)"

status: ## Show deployment status
	@echo "$(GREEN)Deployment Status:$(NC)"
	@kubectl get pods --namespace=nanoclaw 2>/dev/null || echo "$(YELLOW)No pods found$(NC)"
	@echo ""
	@kubectl get services --namespace=nanoclaw 2>/dev/null || echo "$(YELLOW)No services found$(NC)"

cleanup: ## Clean up test resources
	@echo "$(GREEN)Cleaning up...$(NC)"
	@kubectl delete namespace nanoclaw 2>/dev/null || true
	@minikube delete 2>/dev/null || true
	@docker-compose -f $(CI_DIR)/docker-compose.test.yml down -v 2>/dev/null || true
	@docker network rm nanoclaw-e2e 2>/dev/null || true
	@echo "$(GREEN)Cleanup complete$(NC)"

clean-results: ## Clean test results
	@echo "$(GREEN)Cleaning test results...$(NC)"
	@rm -rf $(RESULTS_DIR)
	@echo "$(GREEN)Results cleaned$(NC)"

shell: ## Open shell in test environment
	@docker-compose -f $(CI_DIR)/docker-compose.test.yml exec test-runner /bin/bash

# Development helpers
dev-setup: ## Setup for local development
	@echo "$(GREEN)Setting up for development...$(NC)"
	@npm install
	@make setup-minikube
	@make build-images
	@make build-test-containers
	@make load-images
	@make load-test-containers
	@make deploy-k8s
	@echo "$(GREEN)Development setup complete$(NC)"

quick-test: ## Quick test without full setup
	@echo "$(GREEN)Running quick test...$(NC)"
	@npm run test

watch: ## Watch mode for tests
	@npm run test:watch
