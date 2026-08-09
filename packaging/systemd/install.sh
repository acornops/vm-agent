#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root to install AgentV." >&2
  exit 1
fi
if [[ ! -x /usr/bin/node ]]; then
  echo "AgentV requires Node.js 22 or newer at /usr/bin/node." >&2
  exit 1
fi
node_major="$(/usr/bin/node -p "Number(process.versions.node.split('.')[0])")"
if [[ "${node_major}" -lt 22 ]]; then
  echo "AgentV requires Node.js 22 or newer at /usr/bin/node; found $(/usr/bin/node --version)." >&2
  exit 1
fi

archive_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version="$(/usr/bin/node -p "require('${archive_root}/runtime/package.json').version")"
if [[ ! "${version}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ \
  || "$(basename "${archive_root}")" != "agentv-${version}" ]]; then
  echo "AgentV archive root and runtime version do not match an exact release." >&2
  exit 1
fi
release_root="/opt/acornops/agentv/releases/${version}"

existing_release=false
if [[ -e "${release_root}" || -L "${release_root}" ]]; then
  if [[ -L "${release_root}" \
    || ! -d "${release_root}" \
    || ! -f "${release_root}/package.json" \
    || ! -f "${release_root}/dist/index.js" \
    || ! -f "${release_root}/dist/helper.js" \
    || ! -f "${release_root}/dist/doctor.js" ]]; then
    echo "AgentV ${version} has an incomplete or unsafe existing release directory; refusing to reuse it." >&2
    exit 1
  fi
  installed_version="$(/usr/bin/node -p "require('${release_root}/package.json').version")"
  if [[ "${installed_version}" != "${version}" ]]; then
    echo "AgentV release directory version mismatch: expected ${version}, found ${installed_version}." >&2
    exit 1
  fi
  if ! diff -qr --no-dereference "${archive_root}/runtime" "${release_root}" >/dev/null; then
    echo "AgentV ${version} does not match the verified release archive; refusing to reuse it." >&2
    exit 1
  fi
  if [[ -n "$(find "${release_root}" \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)" ]]; then
    echo "AgentV ${version} has unsafe ownership or writable runtime files; refusing to reuse it." >&2
    exit 1
  fi
  existing_release=true
fi

if [[ "${AGENTV_INSTALL_VERIFY_ONLY:-false}" == true ]]; then
  exit 0
fi

if ! getent group acornops-agent >/dev/null; then
  groupadd --system acornops-agent
fi
if ! id -u acornops-agent >/dev/null 2>&1; then
  useradd --system --gid acornops-agent --home /var/lib/acornops-agentv --shell /usr/sbin/nologin acornops-agent
else
  usermod -a -G acornops-agent acornops-agent
fi
if getent group systemd-journal >/dev/null; then
  usermod -a -G systemd-journal acornops-agent
fi
install -d -o acornops-agent -g acornops-agent -m 0750 /var/lib/acornops-agentv
install -d -o root -g root -m 0700 /var/lib/acornops-agentv/actions
install -d -o root -g root -m 0700 /var/lib/acornops-agentv/install-transactions
install -d -o root -g root -m 0755 /opt/acornops/agentv/releases
install -d -o root -g root -m 0750 /etc/acornops
if [[ "${existing_release}" != true ]]; then
  install_stage="$(mktemp -d "/opt/acornops/agentv/releases/.install-${version}.XXXXXX")"
  cleanup_stage() { rm -rf -- "${install_stage}"; }
  trap cleanup_stage EXIT
  cp -a "${archive_root}/runtime/." "${install_stage}/"
  chown -R root:root "${install_stage}"
  mv "${install_stage}" "${release_root}"
  trap - EXIT
fi

if [[ ! -f /etc/acornops/agentv.env ]]; then
  install -o root -g acornops-agent -m 0640 "${archive_root}/packaging/systemd/agentv.env.example" /etc/acornops/agentv.env
fi
if [[ ! -f /etc/acornops/agentv-actions.json ]]; then
  install -o root -g root -m 0600 "${archive_root}/packaging/systemd/agentv-actions.json.example" /etc/acornops/agentv-actions.json
fi

install -o root -g root -m 0644 "${archive_root}/packaging/systemd/acornops-agentv.service" /etc/systemd/system/acornops-agentv.service
install -o root -g root -m 0644 "${archive_root}/packaging/systemd/acornops-agentv-install-recovery.service" /etc/systemd/system/acornops-agentv-install-recovery.service
install -o root -g root -m 0755 "${archive_root}/packaging/systemd/acornops-agentv-install-recover" /usr/local/sbin/acornops-agentv-install-recover
install -o root -g root -m 0644 "${archive_root}/packaging/systemd/acornops-agentv-actions.service" /etc/systemd/system/acornops-agentv-actions.service
install -o root -g root -m 0644 "${archive_root}/packaging/systemd/acornops-agentv-actions.socket" /etc/systemd/system/acornops-agentv-actions.socket
install -o root -g root -m 0755 "${archive_root}/packaging/systemd/acornops-agentv-doctor" /usr/local/bin/acornops-agentv-doctor

temporary_link="/opt/acornops/agentv/.current-${version}-$$"
ln -s "${release_root}" "${temporary_link}"
mv -Tf "${temporary_link}" /opt/acornops/agentv/current
systemctl daemon-reload
systemctl enable acornops-agentv.service
systemctl enable acornops-agentv-install-recovery.service
if [[ "${AGENTV_INSTALL_MANAGED_BOOTSTRAP:-false}" == true ]]; then
  echo "Prepared AgentV ${version} systemd release."
else
  echo "Installed or refreshed AgentV ${version}. Edit /etc/acornops/agentv.env, run acornops-agentv-doctor, then start acornops-agentv."
fi
echo "The privileged action socket remains disabled until explicitly enabled."
