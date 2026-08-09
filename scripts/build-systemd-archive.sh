#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(/usr/bin/env node -p "require('${repo_root}/package.json').version")"
staging="$(mktemp -d)"
trap 'rm -rf "${staging}"' EXIT

mkdir -p "${staging}/agentv-${version}/runtime" "${staging}/agentv-${version}/packaging"
npm run build --prefix "${repo_root}"
cp -a "${repo_root}/dist" "${repo_root}/package.json" "${repo_root}/package-lock.json" "${staging}/agentv-${version}/runtime/"
npm ci --omit=dev --ignore-scripts --prefix "${staging}/agentv-${version}/runtime"
find "${staging}/agentv-${version}/runtime/node_modules" -type d -empty -delete
cp -a "${repo_root}/packaging/systemd" "${staging}/agentv-${version}/packaging/"
mkdir -p "${repo_root}/release"
COPYFILE_DISABLE=1 tar --no-xattrs -C "${staging}" -czf "${repo_root}/release/agentv-${version}.tar.gz" "agentv-${version}"
sed "s/__AGENTV_RELEASE_VERSION__/${version}/g" \
  "${repo_root}/scripts/install-agentv.sh" > "${repo_root}/release/install-agentv.sh"
chmod 0755 "${repo_root}/release/install-agentv.sh"
if command -v sha256sum >/dev/null; then
  (cd "${repo_root}/release" && sha256sum "agentv-${version}.tar.gz" > "agentv-${version}.tar.gz.sha256")
  (cd "${repo_root}/release" && sha256sum "install-agentv.sh" > "install-agentv.sh.sha256")
else
  (cd "${repo_root}/release" && shasum -a 256 "agentv-${version}.tar.gz" > "agentv-${version}.tar.gz.sha256")
  (cd "${repo_root}/release" && shasum -a 256 "install-agentv.sh" > "install-agentv.sh.sha256")
fi
echo "Built release/agentv-${version}.tar.gz and release/install-agentv.sh"
