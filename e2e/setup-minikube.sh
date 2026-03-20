#!/bin/bash
set -e

# NanoClaw E2E Minikube Setup Script
# Sets up minikube environment for Kubernetes testing

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="kubeclaw-e2e"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "================================================================================"
echo "NanoClaw E2E Test Environment Setup"
echo "================================================================================"
echo ""

# ============================================================================
# PREREQUISITE CHECKS
# ============================================================================

echo -e "${BLUE}Checking prerequisites...${NC}"

# Check for minikube
if ! command -v minikube &> /dev/null; then
    echo -e "${RED}ERROR: minikube not found${NC}"
    echo ""
    echo "Please install minikube:"
    echo "  macOS: brew install minikube"
    echo "  Linux: curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64 && sudo install minikube-linux-amd64 /usr/local/bin/minikube"
    echo "  Windows: choco install minikube"
    echo ""
    echo "For more info: https://minikube.sigs.k8s.io/docs/start/"
    exit 1
fi
echo -e "${GREEN}✓${NC} minikube found: $(minikube version --short 2>/dev/null || minikube version | head -1)"

# Check for kubectl
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}ERROR: kubectl not found${NC}"
    echo ""
    echo "Please install kubectl:"
    echo "  macOS: brew install kubectl"
    echo "  Linux: curl -LO \"https://dl.k8s/release/$(curl -L -s https://dl.k8s/release/stable.txt)/bin/linux/amd64/kubectl\" && sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl"
    echo ""
    exit 1
fi
echo -e "${GREEN}✓${NC} kubectl found: $(kubectl version --client --short 2>/dev/null || kubectl version --client | head -1)"

# Check for docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}ERROR: docker not found${NC}"
    echo ""
    echo "Please install Docker:"
    echo "  https://docs.docker.com/get-docker/"
    exit 1
fi
echo -e "${GREEN}✓${NC} docker found: $(docker --version)"

# Check Docker is running
if ! docker info &> /dev/null; then
    echo -e "${RED}ERROR: Docker is not running${NC}"
    echo "Please start Docker and try again"
    exit 1
fi
echo -e "${GREEN}✓${NC} Docker is running"

echo ""

# ============================================================================
# MINIKUBE SETUP
# ============================================================================

echo -e "${BLUE}Setting up minikube...${NC}"

# Check if minikube is already running
if minikube status &> /dev/null; then
    echo -e "${YELLOW}minikube is already running${NC}"
    echo -n "Do you want to stop and restart with proper resources? [y/N]: "
    read -r response
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo "Stopping existing minikube..."
        minikube stop
        minikube delete
    else
        echo "Using existing minikube cluster"
    fi
else
    echo "No running minikube cluster found"
fi

# Start minikube with proper resources
echo ""
echo "Starting minikube with:"
echo "  - CPUs: 4"
echo "  - Memory: 8GB"
echo "  - Disk: 20GB"
echo "  - Driver: docker (default)"
echo ""

minikube start \
    --cpus=4 \
    --memory=8192 \
    --disk-size=20g \
    --driver=docker \
    --kubernetes-version=stable

if [ $? -ne 0 ]; then
    echo -e "${RED}ERROR: Failed to start minikube${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} minikube started successfully"
echo ""

# Enable required addons
echo -e "${BLUE}Enabling minikube addons...${NC}"
minikube addons enable storage-provisioner 2>/dev/null || true
minikube addons enable default-storageclass 2>/dev/null || true
echo -e "${GREEN}✓${NC} Addons enabled"
echo ""

# ============================================================================
# DOCKER ENVIRONMENT SETUP
# ============================================================================

echo -e "${BLUE}Configuring Docker environment...${NC}"
eval $(minikube docker-env)
echo -e "${GREEN}✓${NC} Docker environment configured for minikube"
echo ""

# ============================================================================
# BUILD DOCKER IMAGES
# ============================================================================

echo -e "${BLUE}Building Docker images...${NC}"

# Build kubeclaw image
if [ -f "${SCRIPT_DIR}/../Dockerfile" ]; then
    echo "Building kubeclaw image..."
    docker build -t kubeclaw:latest "${SCRIPT_DIR}/.."
    echo -e "${GREEN}✓${NC} kubeclaw image built"
else
    echo -e "${YELLOW}Warning:${NC} Dockerfile not found, creating placeholder image"
    # Create a simple placeholder image
    cat <<EOF | docker build -t kubeclaw:latest -f - "${SCRIPT_DIR}"
FROM alpine:latest
RUN echo "Placeholder kubeclaw image"
CMD ["sh", "-c", "echo 'NanoClaw placeholder' && sleep infinity"]
EOF
fi

# Build kubeclaw-agent image
if [ -f "${SCRIPT_DIR}/../container/Dockerfile" ]; then
    echo "Building kubeclaw-agent image..."
    docker build -t kubeclaw-agent:latest "${SCRIPT_DIR}/../container"
    echo -e "${GREEN}✓${NC} kubeclaw-agent image built"
else
    echo -e "${YELLOW}Warning:${NC} Agent Dockerfile not found, creating placeholder image"
    cat <<EOF | docker build -t kubeclaw-agent:latest -f - "${SCRIPT_DIR}"
FROM alpine:latest
RUN echo "Placeholder kubeclaw-agent image"
CMD ["sh"]
EOF
fi

echo ""

# ============================================================================
# VERIFY SETUP
# ============================================================================

echo -e "${BLUE}Verifying setup...${NC}"

# Check cluster info
if kubectl cluster-info &> /dev/null; then
    echo -e "${GREEN}✓${NC} Kubernetes cluster is accessible"
    kubectl cluster-info | head -3
else
    echo -e "${RED}ERROR: Cannot access Kubernetes cluster${NC}"
    exit 1
fi

# Check nodes
NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
if [ "$NODE_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓${NC} Kubernetes nodes: $NODE_COUNT"
    kubectl get nodes
else
    echo -e "${RED}ERROR: No Kubernetes nodes found${NC}"
    exit 1
fi

echo ""

# Check Docker images
echo -e "${BLUE}Verifying Docker images...${NC}"
if docker images | grep -q "kubeclaw"; then
    echo -e "${GREEN}✓${NC} kubeclaw images available:"
    docker images | grep "kubeclaw" || true
else
    echo -e "${YELLOW}Warning:${NC} kubeclaw images not found in registry"
fi

echo ""

# ============================================================================
# CREATE NAMESPACE
# ============================================================================

echo -e "${BLUE}Creating test namespace...${NC}"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo -e "${GREEN}✓${NC} Namespace '$NAMESPACE' ready"
echo ""

# ============================================================================
# SUMMARY
# ============================================================================

echo "================================================================================"
echo -e "${GREEN}Setup complete!${NC}"
echo "================================================================================"
echo ""
echo "Test environment is ready:"
echo "  - minikube running with 4 CPUs, 8GB RAM, 20GB disk"
echo "  - Kubernetes cluster accessible via kubectl"
echo "  - Namespace '$NAMESPACE' created"
echo "  - Docker images built and loaded"
echo ""
echo "Next steps:"
echo "  1. Run tests: ./run-tests.sh"
echo "  2. Access dashboard: minikube dashboard"
echo "  3. View pods: kubectl get pods -n $NAMESPACE"
echo ""
echo "To stop minikube: minikube stop"
echo "To delete minikube: minikube delete"
echo ""
