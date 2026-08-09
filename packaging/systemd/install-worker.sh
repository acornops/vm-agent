#!/usr/bin/env bash
set -euo pipefail

fail() { echo "AgentV installation failed: $1" >&2; exit 1; }
work_dir=""
config_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --work-dir) work_dir="${2:-}"; shift 2 ;;
    --config-dir) config_dir="${2:-}"; shift 2 ;;
    *) fail "invalid installer worker argument" ;;
  esac
done
[[ "$(id -u)" -eq 0 ]] || fail "installer worker must run as root"
[[ "${work_dir}" == /tmp/acornops-agentv-install.* && -d "${work_dir}" ]] || fail "invalid installer work directory"
[[ "${config_dir}" == "${work_dir}/installer-input" && -d "${config_dir}" ]] || fail "invalid installer input directory"
read -r config_uid config_mode < <(stat -c '%u %a' "${config_dir}")
[[ "${config_uid}" == 0 && $((8#${config_mode} & 0077)) -eq 0 ]] || fail "installer input directory is not root-only"

read_input() { [[ -f "${config_dir}/$1" ]] || fail "installer input is incomplete"; REPLY="$(<"${config_dir}/$1")"; }
read_input release-version; release_version="${REPLY}"
read_input platform-url; platform_url="${REPLY}"
read_input target-id; target_id="${REPLY}"
read_input enrollment-token; enrollment_token="${REPLY}"
read_input replace-credential; replace_credential="${REPLY}"
read_input allow-insecure-test; allow_insecure_test="${REPLY}"
rm -f -- "${config_dir}/enrollment-token"

[[ "${release_version}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] || fail "invalid release version handoff"
[[ "${replace_credential}" == true || "${replace_credential}" == false ]] || fail "invalid credential replacement handoff"
archive_root="agentv-${release_version}"
archive_path="${work_dir}/${archive_root}"
[[ -x "${archive_path}/packaging/systemd/install.sh" ]] || fail "verified archive installer is unavailable"
runtime_version="$(/usr/bin/node -p "require('${archive_path}/runtime/package.json').version")"
[[ "${runtime_version}" == "${release_version}" ]] || fail "verified archive version does not match the bootstrap"

transaction_root=/var/lib/acornops-agentv/install-transactions
active_transaction="${transaction_root}/active"
if [[ -e "${active_transaction}" || -L "${active_transaction}" ]]; then
  fail "an incomplete AgentV installation transaction already exists; run 'systemctl start acornops-agentv-install-recovery.service' and retry after recovery completes"
fi

transaction_dir=""
cutover=false
completed=false

rollback_control_plane() {
  [[ -n "${transaction_dir}" && -f "${transaction_dir}/curl.conf" && -f "${transaction_dir}/transaction-id" ]] || return 0
  rollback_status="$(curl --config "${transaction_dir}/curl.conf" -fsS --connect-timeout 10 --max-time 30 --max-filesize 65536 \
    -o /dev/null -w '%{http_code}' -X POST \
    "${platform_url%/}/api/v1/agentv/installations/$(<"${transaction_dir}/transaction-id")/rollback" \
    2>/dev/null)" || return 1
  [[ "${rollback_status}" == 2?? ]]
}

wait_for_restored_connection() {
  [[ -f "${transaction_dir}/previous-active" ]] || return 0
  for _ in {1..60}; do
    if [[ -f /run/acornops-agentv/authenticated ]]; then
      if [[ ! -f "${transaction_dir}/curl.conf" ]]; then return 0; fi
      if curl --config "${transaction_dir}/curl.conf" -fsS --connect-timeout 10 --max-time 30 --max-filesize 65536 \
        "${platform_url%/}/api/v1/agentv/installations/$(<"${transaction_dir}/transaction-id")/status" \
        -o "${work_dir}/rollback-status.json" \
        && /usr/bin/node -e 'const p=require(process.argv[1]);process.exit(p.status==="cancelled"&&p.activeConnected===true?0:1)' \
          "${work_dir}/rollback-status.json"; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

remove_initial_candidate() {
  [[ -n "${transaction_dir}" && ! -f "${transaction_dir}/previous-installation" ]] || return 0
  systemctl disable --now acornops-agentv.service acornops-agentv-actions.socket \
    acornops-agentv-install-recovery.service >/dev/null 2>&1 || true
  if [[ ! -f "${transaction_dir}/previous-systemd-assets" ]]; then
    rm -f -- /etc/systemd/system/acornops-agentv.service \
      /etc/systemd/system/acornops-agentv-actions.service \
      /etc/systemd/system/acornops-agentv-actions.socket \
      /etc/systemd/system/acornops-agentv-install-recovery.service \
      /usr/local/bin/acornops-agentv-doctor \
      /usr/local/sbin/acornops-agentv-install-recover || return 1
  fi
  [[ -f "${transaction_dir}/previous-action-policy" ]] || rm -f -- /etc/acornops/agentv-actions.json || return 1
  if [[ ! -f "${transaction_dir}/previous-release-directory" ]]; then
    rm -rf -- "/opt/acornops/agentv/releases/${release_version}" || return 1
  fi
  systemctl daemon-reload
}

restore_previous() {
  [[ "${cutover}" == true && -n "${transaction_dir}" ]] || return 0
  echo "AgentV cutover failed; restoring the previous installation." >&2
  if [[ -f "${transaction_dir}/previous-current" ]]; then
    previous_current="$(<"${transaction_dir}/previous-current")"
    temporary_link="/opt/acornops/agentv/.rollback-current-$$"
    ln -s "${previous_current}" "${temporary_link}"
    mv -Tf "${temporary_link}" /opt/acornops/agentv/current
  else
    rm -f -- /opt/acornops/agentv/current
  fi
  if [[ -f "${transaction_dir}/previous.env" ]]; then
    install -o root -g acornops-agent -m 0640 "${transaction_dir}/previous.env" /etc/acornops/.agentv.env.rollback
    mv -f /etc/acornops/.agentv.env.rollback /etc/acornops/agentv.env
  else
    rm -f -- /etc/acornops/agentv.env
  fi
  systemctl daemon-reload
  rm -f -- /run/acornops-agentv/authenticated
  if [[ -f "${transaction_dir}/previous-active" ]]; then
    systemctl restart acornops-agentv.service || return 1
  else
    systemctl stop acornops-agentv.service >/dev/null 2>&1 || true
  fi
  if [[ ! -f "${transaction_dir}/previous-installation" ]]; then
    # Keep the recovery unit, candidate release, and candidate environment while
    # the remote commit outcome is uncertain. If rollback cannot be confirmed,
    # boot recovery may need to restore the only remotely valid credential.
    systemctl disable --now acornops-agentv.service acornops-agentv-actions.socket >/dev/null 2>&1 || true
  fi
}

cleanup() {
  rm -rf -- "${work_dir}"
  if [[ "${completed}" == true && -n "${transaction_dir}" ]]; then
    rm -f -- /var/lib/acornops-agentv/install-transactions/active
    rm -rf -- "${transaction_dir}"
  fi
}

on_exit() {
  status=$?
  if [[ "${status}" -ne 0 && "${completed}" != true ]]; then
    original_status="${status}"
    local_rollback=not-needed
    control_rollback=not-needed
    restored_connection=not-needed
    if [[ "${cutover}" == true ]]; then
      if restore_previous; then
        local_rollback=succeeded
        touch "${transaction_dir}/previous-selected"
      else
        local_rollback=failed
      fi
    fi
    if [[ -n "${transaction_dir}" && -f "${transaction_dir}/curl.conf" ]]; then
      if rollback_control_plane; then control_rollback=succeeded; else control_rollback=failed; fi
    fi
    if [[ "${local_rollback}" == succeeded && "${control_rollback}" != failed ]]; then
      if ! remove_initial_candidate; then local_rollback=failed; fi
    fi
    if [[ "${local_rollback}" == succeeded && "${control_rollback}" != failed ]]; then
      if wait_for_restored_connection; then restored_connection=succeeded; else restored_connection=failed; fi
    fi
    [[ -n "${transaction_dir}" ]] && printf '%s\n' recovery_pending > "${transaction_dir}/phase"
    echo "AgentV rollback: local=${local_rollback}, control-plane=${control_rollback}, authenticated=${restored_connection}." >&2
    if [[ "${local_rollback}" != failed && "${control_rollback}" != failed && "${restored_connection}" != failed \
      && -n "${transaction_dir}" ]]; then
      rm -f -- /var/lib/acornops-agentv/install-transactions/active
      rm -rf -- "${transaction_dir}"
      transaction_dir=""
    fi
    status="${original_status}"
  fi
  cleanup
  exit "${status}"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

existing_install=false
had_previous_installation=false
agent_key=""
preserved_ca_setting="ACORNOPS_AGENT_ADDITIONAL_CA_BUNDLE_FILE="
has_existing_env=false
has_existing_release=false
[[ -f /etc/acornops/agentv.env ]] && has_existing_env=true
[[ -L /opt/acornops/agentv/current ]] && has_existing_release=true
[[ "${has_existing_env}" == "${has_existing_release}" ]] \
  || fail "existing AgentV installation is incomplete; generate a replacement-credential command after repairing or removing it"
if [[ "${has_existing_env}" == true ]]; then
  had_previous_installation=true
  read -r env_uid env_group env_mode < <(stat -c '%u %G %a' /etc/acornops/agentv.env)
  [[ "${env_uid}" == 0 && "${env_group}" == acornops-agent && "${env_mode}" == 640 ]] \
    || fail "existing AgentV environment must be owned by root:acornops-agent with mode 0640"
  existing_platform="$(sed -n "s/^ACORNOPS_AGENT_PLATFORM_URL='\([^']*\)'$/\1/p" /etc/acornops/agentv.env)"
  existing_target="$(sed -n "s/^ACORNOPS_TARGET_ID='\([^']*\)'$/\1/p" /etc/acornops/agentv.env)"
  mapfile -t existing_ca_settings < <(sed -n '/^ACORNOPS_AGENT_ADDITIONAL_CA_BUNDLE_FILE=/p' /etc/acornops/agentv.env)
  [[ ${#existing_ca_settings[@]} -le 1 ]] || fail "existing AgentV environment contains duplicate additional CA settings"
  [[ ${#existing_ca_settings[@]} -eq 0 ]] || preserved_ca_setting="${existing_ca_settings[0]}"
  [[ "${existing_platform%/}" == "${platform_url%/}" && "${existing_target}" == "${target_id}" ]] || fail "existing AgentV installation belongs to a different platform or target"
  if [[ "${replace_credential}" == false ]]; then
    agent_key="$(sed -n "s/^ACORNOPS_AGENT_KEY='\([^']*\)'$/\1/p" /etc/acornops/agentv.env)"
    agent_key_prefix="ak_${target_id}_"
    agent_key_secret="${agent_key#"${agent_key_prefix}"}"
    [[ "${agent_key}" == "${agent_key_prefix}"* && "${agent_key_secret}" =~ ^[A-Za-z0-9_-]{32}$ ]] \
      || fail "existing AgentV credential is missing or invalid; generate a replacement-credential command"
    existing_install=true
  fi
fi
[[ "${existing_install}" == true || -n "${enrollment_token}" ]] || fail "this VM has no reusable AgentV credential; generate an enrollment command"

# Exercise the verified candidate's local runtime before consuming a one-use
# enrollment token or changing the installed release. A synthetic credential is
# sufficient because doctor performs outbound-free host and dependency checks.
candidate_doctor_output="${work_dir}/candidate-doctor.json"
candidate_env=(
  "ACORNOPS_AGENT_PLATFORM_URL=${platform_url}"
  "ACORNOPS_TARGET_ID=${target_id}"
  'ACORNOPS_AGENT_KEY=ak_agentv_preflight'
  'ACORNOPS_AGENT_TARGET_TYPE=virtual_machine'
  'ACORNOPS_AGENT_SNAPSHOT_INTERVAL_MS=60000'
  'ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES=1048576'
  'ACORNOPS_AGENT_LOG_LEVEL=info'
  'ACORNOPS_VM_OS_FAMILY=linux'
  'ACORNOPS_VM_SERVICE_MANAGER=systemd'
  'ACORNOPS_VM_ALLOWED_LOG_UNITS=acornops-agentv.service'
  'ACORNOPS_VM_COLLECTOR_MODE=live'
  'ACORNOPS_AGENT_WRITE_ENABLED=false'
  'ACORNOPS_AGENT_ACTIONS_SOCKET=/run/acornops-agentv/actions.sock'
)
[[ "${allow_insecure_test}" == true ]] && candidate_env+=('ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT=true')
env "${candidate_env[@]}" /usr/bin/node "${archive_path}/runtime/dist/index.js" doctor > "${candidate_doctor_output}" \
  || fail "verified AgentV candidate did not pass local readiness checks"

# Validate a same-version immutable release collision without creating users,
# files, symlinks, or systemd state. This must precede enrollment exchange so a
# corrupt local release cannot consume the one-use token before failing.
AGENTV_INSTALL_VERIFY_ONLY=true bash "${archive_path}/packaging/systemd/install.sh" >/dev/null

mkdir -p "${transaction_root}"
chmod 0700 "${transaction_root}"
transaction_dir="${transaction_root}/$(date +%s)-$$"
mkdir -m 0700 "${transaction_dir}"
printf '%s\n' prepared > "${transaction_dir}/phase"

# Persist the complete rollback snapshot before publishing the active marker.
# Boot recovery must never observe a transaction that it could mistake for a
# first install while a working installation already exists.
[[ "${had_previous_installation}" == true ]] && touch "${transaction_dir}/previous-installation"
[[ -e "/opt/acornops/agentv/releases/${release_version}" ]] && touch "${transaction_dir}/previous-release-directory"
[[ -e /etc/acornops/agentv-actions.json ]] && touch "${transaction_dir}/previous-action-policy"
for host_asset in \
  /etc/systemd/system/acornops-agentv.service \
  /etc/systemd/system/acornops-agentv-actions.service \
  /etc/systemd/system/acornops-agentv-actions.socket \
  /etc/systemd/system/acornops-agentv-install-recovery.service \
  /usr/local/bin/acornops-agentv-doctor \
  /usr/local/sbin/acornops-agentv-install-recover; do
  if [[ -e "${host_asset}" ]]; then touch "${transaction_dir}/previous-systemd-assets"; break; fi
done
if [[ -L /opt/acornops/agentv/current ]]; then readlink -f /opt/acornops/agentv/current > "${transaction_dir}/previous-current"; fi
if [[ -f /etc/acornops/agentv.env ]]; then cp -p /etc/acornops/agentv.env "${transaction_dir}/previous.env"; chmod 0600 "${transaction_dir}/previous.env"; fi
if systemctl is-active --quiet acornops-agentv.service; then touch "${transaction_dir}/previous-active"; fi
ln -sfn "${transaction_dir}" "${transaction_root}/active"

transaction_id=""
transaction_secret=""
if [[ "${existing_install}" != true || "${replace_credential}" == true ]]; then
  request_file="${work_dir}/enrollment-request.json"
  response_file="${work_dir}/enrollment-response.json"
  umask 077
  requested_purpose=initial
  [[ "${replace_credential}" == true ]] && requested_purpose=replace
  expected_enrollment_id="${enrollment_token#aev_}"
  expected_enrollment_id="${expected_enrollment_id%%_*}"
  printf '{"targetId":"%s","enrollmentToken":"%s","purpose":"%s"}\n' "${target_id}" "${enrollment_token}" "${requested_purpose}" > "${request_file}"
  enrollment_token=""
  exchange_status="$(curl -fsS --connect-timeout 10 --max-time 30 --max-filesize 65536 -H 'content-type: application/json' \
    --data-binary "@${request_file}" "${platform_url%/}/api/v1/agentv/enrollments/exchange" \
    -o "${response_file}" -w '%{http_code}')" \
    || fail "AgentV enrollment exchange failed; generate a new command if the token was consumed"
  [[ "${exchange_status}" == 2?? ]] || fail "AgentV enrollment exchange returned an unexpected HTTP response"
  # The JavaScript program is intentionally literal; installer values are
  # passed as separate argv entries rather than interpolated into source.
  # shellcheck disable=SC2016
  /usr/bin/node -e '
    const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const target=process.argv[6],enrollment=process.argv[7],purpose=process.argv[8];
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const keyPrefix=`ak_${target}_`;
    if(p.transactionId!==enrollment||!uuid.test(p.transactionId||"")
      ||typeof p.agentKey!=="string"||!p.agentKey.startsWith(keyPrefix)||!/^[A-Za-z0-9_-]{32}$/.test(p.agentKey.slice(keyPrefix.length))
      ||!/^avt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[0-9a-f]{32}$/i.test(p.transactionSecret||"")
      ||p.purpose!==purpose)process.exit(1);
    for(const [path,value] of [[process.argv[2],p.agentKey],[process.argv[3],p.transactionId],[process.argv[4],p.transactionSecret],[process.argv[5],p.purpose]])fs.writeFileSync(path,value,{mode:0o600});
  ' "${response_file}" "${work_dir}/agent-key" "${work_dir}/transaction-id" "${work_dir}/transaction-secret" "${work_dir}/purpose" \
    "${target_id}" "${expected_enrollment_id}" "${requested_purpose}" || fail "AgentV enrollment response was invalid"
  agent_key="$(<"${work_dir}/agent-key")"
  transaction_id="$(<"${work_dir}/transaction-id")"
  transaction_secret="$(<"${work_dir}/transaction-secret")"
  enrollment_purpose="$(<"${work_dir}/purpose")"
  if [[ "${replace_credential}" == true ]]; then
    [[ "${enrollment_purpose}" == replace ]] || fail "enrollment purpose did not authorize credential replacement"
  else
    [[ "${enrollment_purpose}" == initial ]] || fail "replacement enrollment requires --replace-credential"
  fi
  printf '%s' "${transaction_id}" > "${transaction_dir}/transaction-id"
  printf '%s' "${platform_url}" > "${transaction_dir}/platform-url"
  printf 'header = "x-agentv-transaction-secret: %s"\n' "${transaction_secret}" > "${transaction_dir}/curl.conf"
  chmod 0600 "${transaction_dir}/transaction-id" "${transaction_dir}/platform-url" "${transaction_dir}/curl.conf"
fi
transaction_secret=""

# install.sh may atomically switch the current symlink. Mark cutover first so any
# failure in that installer restores the previous link and environment.
cutover=true
printf '%s\n' installing > "${transaction_dir}/phase"
AGENTV_INSTALL_MANAGED_BOOTSTRAP=true bash "${archive_path}/packaging/systemd/install.sh"
config_file="${work_dir}/agentv.env"
umask 077
{
  printf "ACORNOPS_AGENT_PLATFORM_URL='%s'\n" "${platform_url}"
  printf '%s\n' "${preserved_ca_setting}"
  [[ "${allow_insecure_test}" == true && "${platform_url}" == http://* ]] && printf 'ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT=true\n'
  printf "ACORNOPS_TARGET_ID='%s'\n" "${target_id}"
  printf "ACORNOPS_AGENT_KEY='%s'\n" "${agent_key}"
  printf '%s\n' 'ACORNOPS_AGENT_TARGET_TYPE=virtual_machine' 'ACORNOPS_AGENT_SNAPSHOT_INTERVAL_MS=60000' \
    'ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES=1048576' 'ACORNOPS_AGENT_LOG_LEVEL=info' 'ACORNOPS_VM_OS_FAMILY=linux' \
    'ACORNOPS_VM_SERVICE_MANAGER=systemd' 'ACORNOPS_VM_ALLOWED_LOG_UNITS=acornops-agentv.service' \
    'ACORNOPS_VM_COLLECTOR_MODE=live' 'ACORNOPS_AGENT_WRITE_ENABLED=false' 'ACORNOPS_AGENT_ACTIONS_SOCKET=/run/acornops-agentv/actions.sock'
} > "${config_file}"
install -o root -g acornops-agent -m 0640 "${config_file}" /etc/acornops/.agentv.env.install
mv -f /etc/acornops/.agentv.env.install /etc/acornops/agentv.env
readlink -f /opt/acornops/agentv/current > "${transaction_dir}/candidate-current"
cp -p /etc/acornops/agentv.env "${transaction_dir}/candidate.env"
chmod 0600 "${transaction_dir}/candidate.env"
agent_key=""
printf '%s\n' cutover > "${transaction_dir}/phase"

systemctl disable --now acornops-agentv-actions.socket >/dev/null 2>&1 || true
systemctl stop acornops-agentv-actions.service >/dev/null 2>&1 || true
acornops-agentv-doctor
systemctl enable acornops-agentv.service
rm -f -- /run/acornops-agentv/authenticated
systemctl restart acornops-agentv.service
for _ in {1..30}; do systemctl is-active --quiet acornops-agentv.service && break; sleep 1; done
systemctl is-active --quiet acornops-agentv.service || fail "AgentV did not become active"

if [[ -z "${transaction_id}" ]]; then
  authenticated=false
  for _ in {1..60}; do [[ -f /run/acornops-agentv/authenticated ]] && { authenticated=true; break; }; sleep 1; done
  [[ "${authenticated}" == true ]] || fail "AgentV did not reconnect with its existing credential"
fi

if [[ -n "${transaction_id}" ]]; then
  verified=false
  for _ in {1..60}; do
    if curl --config "${transaction_dir}/curl.conf" -fsS --connect-timeout 10 --max-time 30 --max-filesize 65536 \
      "${platform_url%/}/api/v1/agentv/installations/${transaction_id}/status" -o "${work_dir}/status.json"; then
      if /usr/bin/node -e 'const p=require(process.argv[1]);process.exit(p.status==="verified"||p.status==="completed"?0:1)' "${work_dir}/status.json"; then verified=true; break; fi
    fi
    sleep 1
  done
  [[ "${verified}" == true ]] || fail "AgentV did not complete provisional authentication"
  printf '%s\n' committing > "${transaction_dir}/phase"
  commit_status="$(curl --config "${transaction_dir}/curl.conf" -fsS --connect-timeout 10 --max-time 30 --max-filesize 65536 \
    -X POST "${platform_url%/}/api/v1/agentv/installations/${transaction_id}/commit" \
    -o "${work_dir}/commit.json" -w '%{http_code}')" || fail "AgentV credential commit failed"
  [[ "${commit_status}" == 2?? ]] || fail "AgentV credential commit returned an unexpected HTTP response"
  printf '%s\n' control_plane_committed > "${transaction_dir}/phase"
  systemctl restart acornops-agentv.service
  connected=false
  for _ in {1..30}; do
    if systemctl is-active --quiet acornops-agentv.service && [[ -f /run/acornops-agentv/authenticated ]] \
      && curl --config "${transaction_dir}/curl.conf" -fsS --connect-timeout 10 --max-time 30 --max-filesize 65536 \
        "${platform_url%/}/api/v1/agentv/installations/${transaction_id}/status" -o "${work_dir}/status.json" \
      && /usr/bin/node -e 'const p=require(process.argv[1]);process.exit(p.status==="completed"&&p.credentialState==="active"&&p.activeConnected===true?0:1)' "${work_dir}/status.json"; then
      connected=true; break
    fi
    sleep 1
  done
  [[ "${connected}" == true ]] || fail "AgentV did not reconnect with the committed credential"
fi

sleep 3
completed=true
printf '%s\n' committed > "${transaction_dir}/phase"
echo "AgentV ${release_version} installed and started successfully."
