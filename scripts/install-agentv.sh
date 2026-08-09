#!/usr/bin/env bash
set -euo pipefail

readonly AGENTV_RELEASE_VERSION="__AGENTV_RELEASE_VERSION__"

fail() { echo "AgentV installation failed: $1" >&2; exit 1; }
require_value() { [[ -n "${2:-}" && "${2:-}" != --* ]] || fail "$1 requires a value"; }

release_base_url=""
platform_url=""
target_id=""
enrollment_token=""
replace_credential=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-base-url) require_value "$1" "${2:-}"; release_base_url="$2"; shift 2 ;;
    --platform-url) require_value "$1" "${2:-}"; platform_url="$2"; shift 2 ;;
    --target-id) require_value "$1" "${2:-}"; target_id="$2"; shift 2 ;;
    --enrollment-token) require_value "$1" "${2:-}"; enrollment_token="$2"; shift 2 ;;
    --replace-credential) replace_credential=true; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "${AGENTV_RELEASE_VERSION}" != "__AGENTV_""RELEASE_VERSION__" ]] || fail "release version was not embedded during packaging"
[[ -n "${release_base_url}" ]] || fail "--release-base-url is required"
[[ -n "${platform_url}" ]] || fail "--platform-url is required"
[[ -n "${target_id}" ]] || fail "--target-id is required"
[[ "${replace_credential}" == false || -n "${enrollment_token}" ]] || fail "--replace-credential requires --enrollment-token"
for value in "${release_base_url}" "${platform_url}" "${target_id}" "${enrollment_token}"; do
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || fail "configuration values must be single-line"
done
for value in "${release_base_url}" "${platform_url}"; do
  [[ "${value}" != *"'"* && "${value}" != *\\* ]] || fail "URLs must not contain quotes or backslashes"
done

allow_insecure_test=false
if [[ "${CI:-}" == true && "${AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST:-}" == true ]]; then allow_insecure_test=true; fi
for named_url in release_base_url platform_url; do
  value="${!named_url}"
  if [[ ! "${value}" =~ ^https://[^/@?#[:space:]]+(/[^?#[:space:]]*)?$ ]]; then
    [[ "${allow_insecure_test}" == true && "${value}" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/.*)?$ ]] || fail "--${named_url//_/-} must be an HTTPS URL"
  fi
done
[[ "${target_id}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] || fail "--target-id has an invalid format"
[[ -z "${enrollment_token}" || "${enrollment_token}" =~ ^aev_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}_[A-Za-z0-9_-]{43}$ ]] \
  || fail "--enrollment-token has an invalid format"
[[ "$(id -u)" -eq 0 ]] || fail "run the generated command with sudo"
[[ "$(uname -s)" == Linux ]] || fail "AgentV requires Linux"
[[ -d /run/systemd/system ]] || fail "AgentV requires a host booted with systemd"
for command_name in curl tar sha256sum install getent groupadd useradd usermod systemctl mktemp rm mv ln cp chown diff basename find stat readlink sed date sleep chmod mkdir touch env flock; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is missing: ${command_name}"
done
[[ -x /usr/bin/node ]] || fail "Node.js 22 or newer is required at /usr/bin/node"
[[ -x /usr/sbin/runuser ]] || fail "required command is missing: /usr/sbin/runuser"
node_major="$(/usr/bin/node -p "Number(process.versions.node.split('.')[0])")"
[[ "${node_major}" -ge 22 ]] || fail "Node.js 22 or newer is required at /usr/bin/node"

exec 9>/run/lock/acornops-agentv-install.lock
flock -n 9 || fail "another AgentV installation is already running"

archive_name="agentv-${AGENTV_RELEASE_VERSION}.tar.gz"
release_url="${release_base_url%/}/v${AGENTV_RELEASE_VERSION}"
work_dir="$(mktemp -d /tmp/acornops-agentv-install.XXXXXX)"
release_transport=()
[[ "${allow_insecure_test}" == true ]] || release_transport=(--proto '=https' --proto-redir '=https')
cleanup() { rm -rf -- "${work_dir}"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

curl "${release_transport[@]}" -fsSL --retry 3 --retry-all-errors --connect-timeout 10 --max-time 300 "${release_url}/${archive_name}" -o "${work_dir}/${archive_name}" \
  || fail "could not download the AgentV release archive"
curl "${release_transport[@]}" -fsSL --retry 3 --retry-all-errors --connect-timeout 10 --max-time 60 "${release_url}/${archive_name}.sha256" -o "${work_dir}/${archive_name}.sha256" \
  || fail "could not download the AgentV release checksum"
mapfile -t checksum_lines < "${work_dir}/${archive_name}.sha256"
[[ ${#checksum_lines[@]} -eq 1 ]] || fail "release checksum must contain exactly one entry"
read -r expected_checksum declared_name extra <<< "${checksum_lines[0]}"
declared_name="${declared_name#\*}"
[[ "${expected_checksum}" =~ ^[0-9a-fA-F]{64}$ && "${declared_name}" == "${archive_name}" && -z "${extra:-}" ]] || fail "release checksum has an invalid format or filename"
read -r actual_checksum _ < <(sha256sum "${work_dir}/${archive_name}")
[[ "${actual_checksum,,}" == "${expected_checksum,,}" ]] || fail "release archive checksum did not match"

archive_root="agentv-${AGENTV_RELEASE_VERSION}"
mapfile -t archive_entries < <(tar -tzf "${work_dir}/${archive_name}")
mapfile -t archive_metadata < <(tar -tvzf "${work_dir}/${archive_name}")
[[ ${#archive_entries[@]} -gt 0 && ${#archive_metadata[@]} -eq ${#archive_entries[@]} ]] || fail "release archive metadata is inconsistent"
has_installer=false
has_worker=false
for metadata in "${archive_metadata[@]}"; do [[ "${metadata:0:1}" == - || "${metadata:0:1}" == d ]] || fail "release archive contains an unsupported entry type"; done
for entry in "${archive_entries[@]}"; do
  [[ "${entry}" != /* && ! "${entry}" =~ (^|/)\.\.(/|$) ]] || fail "release archive contains an unsafe path"
  [[ "${entry}" == "${archive_root}/"* || "${entry}" == "${archive_root}" ]] || fail "release archive has an unexpected root"
  [[ "${entry}" == "${archive_root}/packaging/systemd/install.sh" ]] && has_installer=true
  [[ "${entry}" == "${archive_root}/packaging/systemd/install-worker.sh" ]] && has_worker=true
done
[[ "${has_installer}" == true && "${has_worker}" == true ]] || fail "release archive is missing its systemd installer"
tar --no-same-owner --no-same-permissions -xzf "${work_dir}/${archive_name}" -C "${work_dir}"

# Move all inputs, including the one-use secret, into a root-only handoff. The exec
# below replaces the token-bearing bootstrap process, so the worker argv is secret-free.
config_dir="${work_dir}/installer-input"
mkdir -m 0700 "${config_dir}"
umask 077
printf '%s' "${AGENTV_RELEASE_VERSION}" > "${config_dir}/release-version"
printf '%s' "${platform_url}" > "${config_dir}/platform-url"
printf '%s' "${target_id}" > "${config_dir}/target-id"
printf '%s' "${enrollment_token}" > "${config_dir}/enrollment-token"
printf '%s' "${replace_credential}" > "${config_dir}/replace-credential"
printf '%s' "${allow_insecure_test}" > "${config_dir}/allow-insecure-test"
enrollment_token=""
exec bash "${work_dir}/${archive_root}/packaging/systemd/install-worker.sh" \
  --work-dir "${work_dir}" --config-dir "${config_dir}"
