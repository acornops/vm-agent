#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run the AgentV systemd smoke as root." >&2
  exit 1
fi
if [[ "${CI:-}" != "true" || "${AGENTV_SYSTEMD_SMOKE_ALLOW:-}" != "true" ]]; then
  echo "Refusing to mutate systemd outside an explicitly enabled ephemeral CI runner." >&2
  exit 1
fi
if [[ ! -d /run/systemd/system ]]; then
  echo "A live systemd host is required." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(/usr/bin/node -p "require('${repo_root}/package.json').version")"
work="$(mktemp -d)"
marker="${work}/authenticated"
release_assets="${work}/release-assets"
server_pid=""
action_smoke=""
committed_recovery=""
uncommitted_recovery=""
unreachable_recovery=""
closed_grace_recovery=""
closed_grace_initial_recovery=""

cleanup() {
  systemctl disable --now acornops-agentv-smoke-worker.service >/dev/null 2>&1 || true
  systemctl stop acornops-agentv.service acornops-agentv-actions.service acornops-agentv-actions.socket >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/acornops-agentv-smoke-worker.service
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ -n "${server_pid}" ]]; then kill "${server_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${action_smoke}" ]]; then rm -f -- "${action_smoke}"; fi
  rm -f -- /var/lib/acornops-agentv/install-transactions/active
  for recovery_directory in "${committed_recovery}" "${uncommitted_recovery}" "${unreachable_recovery}" \
    "${closed_grace_recovery}" "${closed_grace_initial_recovery}"; do
    [[ -n "${recovery_directory}" ]] && rm -rf -- "${recovery_directory}"
  done
  rm -rf -- "${work}"
}
trap cleanup EXIT

mkdir -p "${release_assets}/v${version}"
cp "${repo_root}/release/install-agentv.sh" \
  "${repo_root}/release/install-agentv.sh.sha256" \
  "${repo_root}/release/agentv-${version}.tar.gz" \
  "${repo_root}/release/agentv-${version}.tar.gz.sha256" \
  "${release_assets}/v${version}/"

/usr/bin/node "${repo_root}/scripts/systemd-smoke-server.mjs" "${marker}" "${release_assets}" "${version}" &
server_pid="$!"

wait_for_authentication() {
  for _ in $(seq 1 100); do
    [[ -f "${marker}" ]] && return 0
    sleep 0.1
  done
  journalctl -u acornops-agentv.service --no-pager -n 100
  return 1
}

for _ in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:18082/releases/download/v${version}/install-agentv.sh" >/dev/null 2>&1 && break
  sleep 0.1
done
# An initial-install failure after provisional authentication must return the host
# to an uninstalled state before the real canary enrollment runs.
if CI=true AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST=true bash "${repo_root}/release/install-agentv.sh" \
  --release-base-url http://127.0.0.1:18082/releases/download \
  --platform-url http://127.0.0.1:18081 \
  --target-id agentv-systemd-smoke \
  --enrollment-token aev_00000000-0000-4000-8000-000000000000_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz; then
  echo "Injected initial AgentV commit failure unexpectedly succeeded." >&2
  exit 1
fi
[[ ! -e /opt/acornops/agentv/current ]]
[[ ! -e /etc/acornops/agentv.env ]]
[[ ! -e /etc/systemd/system/acornops-agentv.service ]]
[[ ! -e /etc/systemd/system/acornops-agentv-install-recovery.service ]]
[[ ! -e "/opt/acornops/agentv/releases/${version}" ]]

CI=true AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST=true bash "${repo_root}/release/install-agentv.sh" \
  --release-base-url http://127.0.0.1:18082/releases/download \
  --platform-url http://127.0.0.1:18081 \
  --target-id agentv-systemd-smoke \
  --enrollment-token aev_11111111-1111-4111-8111-111111111111_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
same_command_pid="$(systemctl show acornops-agentv.service --property=MainPID --value)"
CI=true AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST=true bash "${repo_root}/release/install-agentv.sh" \
  --release-base-url http://127.0.0.1:18082/releases/download \
  --platform-url http://127.0.0.1:18081 \
  --target-id agentv-systemd-smoke
systemctl is-active --quiet acornops-agentv.service
[[ "$(systemctl show acornops-agentv.service --property=MainPID --value)" != "${same_command_pid}" ]]

policy_file="${work}/agentv-actions.json"
printf '%s\n' '{"schemaVersion":1,"restartServices":["acornops-agentv-smoke-worker.service"]}' > "${policy_file}"
install -o root -g root -m 0600 "${policy_file}" /etc/acornops/agentv-actions.json

unit_file="${work}/acornops-agentv-smoke-worker.service"
printf '%s\n' \
  '[Unit]' \
  'Description=Disposable AgentV restart smoke worker' \
  '[Service]' \
  'Type=simple' \
  'ExecStart=/usr/bin/sleep infinity' > "${unit_file}"
install -o root -g root -m 0644 "${unit_file}" /etc/systemd/system/acornops-agentv-smoke-worker.service

systemd-analyze verify \
  /etc/systemd/system/acornops-agentv.service \
  /etc/systemd/system/acornops-agentv-actions.socket \
  /etc/systemd/system/acornops-agentv-actions.service \
  /etc/systemd/system/acornops-agentv-install-recovery.service \
  /etc/systemd/system/acornops-agentv-smoke-worker.service
systemctl daemon-reload
systemctl enable --now acornops-agentv-smoke-worker.service acornops-agentv-actions.socket

wait_for_authentication
systemctl is-active --quiet acornops-agentv.service
[[ -f /run/acornops-agentv/authenticated ]]
[[ "$(systemctl show acornops-agentv.service --property=User --value)" == "acornops-agent" ]]
acornops-agentv-doctor
action_smoke="$(mktemp /tmp/acornops-agentv-action-smoke.XXXXXX.mjs)"
install -o acornops-agent -g acornops-agent -m 0400 "${repo_root}/scripts/systemd-action-smoke.mjs" "${action_smoke}"
/usr/sbin/runuser --user acornops-agent -- /usr/bin/node "${action_smoke}"
original_pid="$(systemctl show acornops-agentv.service --property=MainPID --value)"
rm -f "${marker}"
if CI=true AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST=true bash "${repo_root}/release/install-agentv.sh" \
  --release-base-url http://127.0.0.1:18082/releases/download \
  --platform-url http://127.0.0.1:18081 \
  --target-id agentv-systemd-smoke-other \
  --enrollment-token aev_22222222-2222-4222-8222-222222222222_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --replace-credential; then
  echo "Credential replacement for a mismatched local target unexpectedly succeeded." >&2
  exit 1
fi
[[ "$(systemctl show acornops-agentv.service --property=MainPID --value)" == "${original_pid}" ]]
CI=true AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST=true bash "${repo_root}/release/install-agentv.sh" \
  --release-base-url http://127.0.0.1:18082/releases/download \
  --platform-url http://127.0.0.1:18081 \
  --target-id agentv-systemd-smoke \
  --enrollment-token aev_22222222-2222-4222-8222-222222222222_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --replace-credential
grep -q "^ACORNOPS_AGENT_KEY='ak_agentv-systemd-smoke_rotatedsystemdsmokekey0000000000'$" /etc/acornops/agentv.env
systemctl is-active --quiet acornops-agentv.service
wait_for_authentication
grep -q '"agentKey":"ak_agentv-systemd-smoke_rotatedsystemdsmokekey0000000000"' "${marker}"
rotated_pid="$(systemctl show acornops-agentv.service --property=MainPID --value)"
[[ "${rotated_pid}" != "${original_pid}" ]]
! systemctl is-enabled --quiet acornops-agentv-actions.socket
! systemctl is-active --quiet acornops-agentv-actions.socket

recovery_root=/var/lib/acornops-agentv/install-transactions
committed_recovery="${recovery_root}/smoke-committed-$$"
mkdir -m 0700 "${committed_recovery}"
printf '%s' '22222222-2222-4222-8222-222222222222' > "${committed_recovery}/transaction-id"
printf '%s' 'http://127.0.0.1:18081' > "${committed_recovery}/platform-url"
printf '%s\n' 'header = "x-agentv-transaction-secret: avt_22222222-2222-4222-8222-222222222222_22222222222242228222222222222222"' > "${committed_recovery}/curl.conf"
printf '%s\n' control_plane_committed > "${committed_recovery}/phase"
ln -sfn "${committed_recovery}" "${recovery_root}/active"
acornops-agentv-install-recover
[[ ! -e "${recovery_root}/active" && ! -e "${committed_recovery}" ]]

curl -fsS -H 'content-type: application/json' --data-binary \
  '{"targetId":"agentv-systemd-smoke","enrollmentToken":"aev_33333333-3333-4333-8333-333333333333_ccccccccccccccccccccccccccccccccccccccccccc","purpose":"replace"}' \
  http://127.0.0.1:18081/api/v1/agentv/enrollments/exchange >/dev/null
uncommitted_recovery="${recovery_root}/smoke-uncommitted-$$"
mkdir -m 0700 "${uncommitted_recovery}"
readlink -f /opt/acornops/agentv/current > "${uncommitted_recovery}/previous-current"
cp -p /etc/acornops/agentv.env "${uncommitted_recovery}/previous.env"
touch "${uncommitted_recovery}/previous-installation" "${uncommitted_recovery}/previous-active"
printf '%s' '33333333-3333-4333-8333-333333333333' > "${uncommitted_recovery}/transaction-id"
printf '%s' 'http://127.0.0.1:18081' > "${uncommitted_recovery}/platform-url"
printf '%s\n' 'header = "x-agentv-transaction-secret: avt_33333333-3333-4333-8333-333333333333_33333333333343338333333333333333"' > "${uncommitted_recovery}/curl.conf"
printf '%s\n' cutover > "${uncommitted_recovery}/phase"
ln -sfn "${uncommitted_recovery}" "${recovery_root}/active"
if acornops-agentv-install-recover; then echo 'Uncommitted recovery unexpectedly completed before a fresh status check.' >&2; exit 1; fi
[[ -L "${recovery_root}/active" && "$(<"${uncommitted_recovery}/phase")" == recovery_pending ]]
[[ -x /usr/local/sbin/acornops-agentv-install-recover ]]
acornops-agentv-install-recover
[[ ! -e "${uncommitted_recovery}" && ! -e "${recovery_root}/active" ]]
# Recovery is idempotent after confirmed rollback state has been removed.
acornops-agentv-install-recover
[[ ! -e "${recovery_root}/active" ]]

unreachable_recovery="${recovery_root}/smoke-unreachable-$$"
mkdir -m 0700 "${unreachable_recovery}"
printf '%s' '44444444-4444-4444-8444-444444444444' > "${unreachable_recovery}/transaction-id"
printf '%s' 'http://127.0.0.1:9' > "${unreachable_recovery}/platform-url"
printf '%s\n' 'header = "x-agentv-transaction-secret: unreachable"' > "${unreachable_recovery}/curl.conf"
printf '%s\n' cutover > "${unreachable_recovery}/phase"
ln -sfn "${unreachable_recovery}" "${recovery_root}/active"
if acornops-agentv-install-recover; then echo 'Recovery unexpectedly changed state while the control plane was unreachable.' >&2; exit 1; fi
[[ -L "${recovery_root}/active" && "$(<"${unreachable_recovery}/phase")" == cutover ]]
rm -f -- "${recovery_root}/active"
rm -rf -- "${unreachable_recovery}"

# If boot recovery discovers that the committed replacement can no longer be
# rolled back, it must restore and prove the committed candidate rather than
# leave the host on the now-invalid prior credential.
closed_grace_recovery="${recovery_root}/smoke-closed-grace-$$"
mkdir -m 0700 "${closed_grace_recovery}"
readlink -f /opt/acornops/agentv/current > "${closed_grace_recovery}/previous-current"
readlink -f /opt/acornops/agentv/current > "${closed_grace_recovery}/candidate-current"
cp -p /etc/acornops/agentv.env "${closed_grace_recovery}/candidate.env"
sed 's/rotatedsystemdsmokekey0000000000/systemdsmokekey00000000000000000/' \
  /etc/acornops/agentv.env > "${closed_grace_recovery}/previous.env"
install -o root -g acornops-agent -m 0640 "${closed_grace_recovery}/previous.env" /etc/acornops/agentv.env
touch "${closed_grace_recovery}/previous-installation" \
  "${closed_grace_recovery}/previous-active" \
  "${closed_grace_recovery}/previous-selected"
printf '%s' '55555555-5555-4555-8555-555555555555' > "${closed_grace_recovery}/transaction-id"
printf '%s' 'http://127.0.0.1:18081' > "${closed_grace_recovery}/platform-url"
printf '%s\n' 'header = "x-agentv-transaction-secret: avt_55555555-5555-4555-8555-555555555555_55555555555545558555555555555555"' > "${closed_grace_recovery}/curl.conf"
printf '%s\n' recovery_pending > "${closed_grace_recovery}/phase"
ln -sfn "${closed_grace_recovery}" "${recovery_root}/active"
if acornops-agentv-install-recover; then echo 'Closed-grace recovery unexpectedly completed before candidate authentication.' >&2; exit 1; fi
grep -q '^ACORNOPS_AGENT_KEY='"'"'ak_agentv-systemd-smoke_rotatedsystemdsmokekey0000000000'"'"'$' /etc/acornops/agentv.env
[[ -L "${recovery_root}/active" && ! -e "${closed_grace_recovery}/previous-selected" ]]
wait_for_authentication
acornops-agentv-install-recover
[[ ! -e "${closed_grace_recovery}" && ! -e "${recovery_root}/active" ]]

# The same closed-grace decision must also recover a first installation after
# local rollback retained its candidate and recovery assets while remote state
# was unreachable. There is no previous installation to fall back to.
closed_grace_initial_recovery="${recovery_root}/smoke-closed-grace-initial-$$"
mkdir -m 0700 "${closed_grace_initial_recovery}"
readlink -f /opt/acornops/agentv/current > "${closed_grace_initial_recovery}/candidate-current"
cp -p /etc/acornops/agentv.env "${closed_grace_initial_recovery}/candidate.env"
touch "${closed_grace_initial_recovery}/previous-selected"
printf '%s' '55555555-5555-4555-8555-555555555555' > "${closed_grace_initial_recovery}/transaction-id"
printf '%s' 'http://127.0.0.1:18081' > "${closed_grace_initial_recovery}/platform-url"
printf '%s\n' 'header = "x-agentv-transaction-secret: avt_55555555-5555-4555-8555-555555555555_55555555555545558555555555555555"' > "${closed_grace_initial_recovery}/curl.conf"
printf '%s\n' recovery_pending > "${closed_grace_initial_recovery}/phase"
systemctl disable --now acornops-agentv.service >/dev/null
rm -f -- /opt/acornops/agentv/current /etc/acornops/agentv.env /run/acornops-agentv/authenticated "${marker}"
ln -sfn "${closed_grace_initial_recovery}" "${recovery_root}/active"
if acornops-agentv-install-recover; then echo 'Initial closed-grace recovery unexpectedly completed before candidate authentication.' >&2; exit 1; fi
[[ -L "${recovery_root}/active" && ! -e "${closed_grace_initial_recovery}/previous-selected" ]]
systemctl is-enabled --quiet acornops-agentv.service
systemctl is-active --quiet acornops-agentv.service
wait_for_authentication
acornops-agentv-install-recover
[[ ! -e "${closed_grace_initial_recovery}" && ! -e "${recovery_root}/active" ]]

tar -xzf "${repo_root}/release/agentv-${version}.tar.gz" -C "${work}"
archive_root="${work}/agentv-${version}"
upgrade_root="${work}/agentv-${version}-smoke-upgrade"
upgrade_version="${version}-smoke-upgrade"
cp -a "${archive_root}" "${upgrade_root}"
/usr/bin/node --input-type=module --eval \
  "import fs from 'node:fs'; const file=process.argv[1]; const value=JSON.parse(fs.readFileSync(file)); value.version += '-smoke-upgrade'; fs.writeFileSync(file, JSON.stringify(value, null, 2)+'\\n');" \
  "${upgrade_root}/runtime/package.json"
mkdir -p "${release_assets}/v${upgrade_version}"
tar -C "${work}" -czf "${release_assets}/v${upgrade_version}/agentv-${upgrade_version}.tar.gz" "agentv-${upgrade_version}"
(cd "${release_assets}/v${upgrade_version}" && sha256sum "agentv-${upgrade_version}.tar.gz" > "agentv-${upgrade_version}.tar.gz.sha256")
sed "s/readonly AGENTV_RELEASE_VERSION=\"${version}\"/readonly AGENTV_RELEASE_VERSION=\"${upgrade_version}\"/" \
  "${repo_root}/release/install-agentv.sh" > "${release_assets}/v${upgrade_version}/install-agentv.sh"
chmod 0755 "${release_assets}/v${upgrade_version}/install-agentv.sh"
(cd "${release_assets}/v${upgrade_version}" && sha256sum install-agentv.sh > install-agentv.sh.sha256)
rm -f "${marker}"
CI=true AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST=true bash "${release_assets}/v${upgrade_version}/install-agentv.sh" \
  --release-base-url http://127.0.0.1:18082/releases/download \
  --platform-url http://127.0.0.1:18081 \
  --target-id agentv-systemd-smoke
[[ "$(readlink /opt/acornops/agentv/current)" == "/opt/acornops/agentv/releases/${upgrade_version}" ]]
systemctl is-active --quiet acornops-agentv.service
wait_for_authentication
systemctl stop acornops-agentv-actions.service >/dev/null 2>&1 || true

recovery_transaction="/var/lib/acornops-agentv/install-transactions/smoke-recovery-$$"
mkdir -m 0700 "${recovery_transaction}"
printf '%s\n' "/opt/acornops/agentv/releases/${version}" > "${recovery_transaction}/previous-current"
cp -p /etc/acornops/agentv.env "${recovery_transaction}/previous.env"
touch "${recovery_transaction}/previous-installation" "${recovery_transaction}/previous-active"
printf '%s\n' cutover > "${recovery_transaction}/phase"
ln -sfn "${recovery_transaction}" /var/lib/acornops-agentv/install-transactions/active
if acornops-agentv-install-recover; then echo 'Repair recovery unexpectedly completed before restored authentication.' >&2; exit 1; fi
[[ -L /var/lib/acornops-agentv/install-transactions/active ]]
wait_for_authentication
acornops-agentv-install-recover
[[ ! -e /var/lib/acornops-agentv/install-transactions/active ]]
[[ "$(readlink /opt/acornops/agentv/current)" == "/opt/acornops/agentv/releases/${version}" ]]
rm -rf -- "${recovery_transaction}"
systemctl restart acornops-agentv.service
systemctl stop acornops-agentv-actions.service >/dev/null 2>&1 || true
[[ "$(readlink /opt/acornops/agentv/current)" == "/opt/acornops/agentv/releases/${version}" ]]

bash "${archive_root}/packaging/systemd/uninstall.sh"
[[ ! -e /etc/systemd/system/acornops-agentv.service ]]
[[ ! -e /etc/systemd/system/acornops-agentv-actions.socket ]]
[[ -f /etc/acornops/agentv.env ]]
[[ -f /etc/acornops/agentv-actions.json ]]
[[ -d "/opt/acornops/agentv/releases/${version}" ]]
echo "AgentV live systemd install, restart, upgrade, rollback, and uninstall smoke passed."
