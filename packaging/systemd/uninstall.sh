#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root to uninstall AgentV." >&2
  exit 1
fi

systemctl disable --now acornops-agentv.service acornops-agentv-actions.socket acornops-agentv-install-recovery.service 2>/dev/null || true
rm -f /etc/systemd/system/acornops-agentv.service /etc/systemd/system/acornops-agentv-actions.service /etc/systemd/system/acornops-agentv-actions.socket /etc/systemd/system/acornops-agentv-install-recovery.service /usr/local/bin/acornops-agentv-doctor /usr/local/sbin/acornops-agentv-install-recover
systemctl daemon-reload
echo "Removed AgentV units and doctor command. Configuration, action policy, ledger, and releases were preserved for recovery."
