#!/bin/bash
# ============================================
# Canvascope — Add School Domain
# ============================================
# Usage: ./scripts/add-school.sh <domain-or-url>
#
# Examples:
#   ./scripts/add-school.sh canvas.stanford.edu
#   ./scripts/add-school.sh https://canvas.asu.edu/
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -z "$1" ]; then
    echo -e "${RED}Error: No domain provided.${NC}"
    echo ""
    echo "Usage: ./scripts/add-school.sh <domain-or-url>"
    echo "Example: ./scripts/add-school.sh canvas.stanford.edu"
    echo "         ./scripts/add-school.sh https://canvas.mit.edu/"
    exit 1
fi

# Extract domain from input (handles full URLs and plain domains)
DOMAIN=$(python3 -c "
import sys
d = sys.argv[1]
# Strip protocol
for prefix in ['https://', 'http://']:
    if d.startswith(prefix):
        d = d[len(prefix):]
        break
# Strip path and trailing slash
d = d.split('/')[0]
print(d.lower())
" "$1")

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  Canvascope — Add School Domain${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Domain: ${GREEN}$DOMAIN${NC}"
echo ""

# Hand off to the Python script which does the actual work
python3 "$SCRIPT_DIR/add_school.py" "$PROJECT_DIR" "$DOMAIN"

STATUS=$?
if [ $STATUS -eq 0 ]; then
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  ✓ Successfully added ${DOMAIN}${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${YELLOW}Remember to reload the extension in chrome://extensions${NC}"
    echo ""
elif [ $STATUS -eq 2 ]; then
    echo -e "${YELLOW}⚠  Domain '${DOMAIN}' already exists in the project.${NC}"
    exit 0
else
    echo -e "${RED}✗ Failed to add domain. See errors above.${NC}"
    exit 1
fi
