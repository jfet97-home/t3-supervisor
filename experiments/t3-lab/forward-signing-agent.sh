#!/bin/sh
set -eu

# keep a dedicated forwarded socket available to detached guest processes
exec /usr/bin/ssh \
  -o BatchMode=yes \
  -o ControlMaster=no \
  -o ControlPath=none \
  -o ControlPersist=no \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -A -T lima-t3-lab '
    set -eu
    test -S "$SSH_AUTH_SOCK"
    agent_link="$HOME/.ssh/1password-agent.sock"
    if test -e "$agent_link" && ! test -L "$agent_link"; then
      echo "Refusing to replace an existing non-symlink agent path." >&2
      exit 1
    fi
    ln -sfn "$SSH_AUTH_SOCK" "$agent_link"
    exec sleep infinity
  '
