#!/bin/bash
cd "$(dirname "$0")"
PORT=8080
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║          AyangeTV Web Server          ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Open on this Mac:    http://localhost:$PORT"
echo "  Open on any device:  http://$IP:$PORT"
echo ""
echo "  (Phone, tablet, TV — any device on your WiFi)"
echo ""
echo "  Press Ctrl+C to stop"
echo ""

python3 server.py
