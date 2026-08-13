#!/bin/bash
cd /home/gizmo/meteora-farmer
WALLET=9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2
BASE=https://dlmm.datapi.meteora.ag

echo "=== PORTFOLIO TOTAL ==="
curl -sS "$BASE/portfolio/total?user=$WALLET" | head -c 8000
echo
echo
echo "=== OPEN PORTFOLIO ==="
curl -sS "$BASE/portfolio/open?user=$WALLET&page_size=50" | head -c 12000
echo
echo
echo "=== CLOSED PORTFOLIO (90d) ==="
curl -sS "$BASE/portfolio?user=$WALLET&page=1&page_size=50&days_back=90" | head -c 20000
echo
