#!/usr/bin/env bash
# End-to-end smoke test for the CRUD API.
# Requires: controller running locally, CONTROLLER_API_TOKENS set in .env,
# mysql CLI available, jq installed, and .env loaded in the shell.
#
# Usage:
#   set -a; source .env; set +a
#   ./scripts/smoke-crud.sh

set -euo pipefail

BASE="${BASE:-http://localhost:${CONTROLLER_PORT:-4000}}"
TOKEN="${SMOKE_TOKEN:-$(echo "${CONTROLLER_API_TOKENS:?must be set}" | cut -d= -f2 | cut -d, -f1)}"
DB_PORT="${DB_PORT:-3306}"
MYSQL_CMD=(mysql -h "${DB_HOST:-127.0.0.1}" -P "$DB_PORT" -u "${DB_USER:-root}" -p"${DB_PASSWORD:-}" "${DB_NAME:-controlplane}")

H=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

step()      { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
assert_eq() { local want="$1" got="$2" what="$3"; [[ "$want" == "$got" ]] || { echo "FAIL $what: want $want got $got"; exit 1; }; }

step "Create server"
SERVER_JSON=$(curl -fsS "${H[@]}" -X POST "$BASE/api/servers" \
  -d '{"name":"smoke-srv","hostname":"localhost","artifact_transfer":"http"}')
SERVER_ID=$(echo "$SERVER_JSON" | jq -r .server.id)
RAW_TOKEN=$(echo "$SERVER_JSON" | jq -r .rawToken)
[[ -n "$SERVER_ID" && "$SERVER_ID" != "null" ]] || { echo "no server id"; exit 1; }
[[ ${#RAW_TOKEN} -ge 30 ]] || { echo "raw token too short"; exit 1; }

step "Create group"
GROUP_JSON=$(curl -fsS "${H[@]}" -X POST "$BASE/api/groups" -d '{"name":"smoke-grp"}')
GROUP_ID=$(echo "$GROUP_JSON" | jq -r .id)

step "Create app"
APP_JSON=$(curl -fsS "${H[@]}" -X POST "$BASE/api/applications" \
  -d "{\"name\":\"smoke-app\",\"server_id\":$SERVER_ID,\"group_id\":$GROUP_ID,\"runtime\":\"node\",\"workdir\":\"/tmp/smoke\",\"start_cmd\":\"node index.js\"}")
APP_ID=$(echo "$APP_JSON" | jq -r .id)

step "Patch app branch"
curl -fsS "${H[@]}" -X PATCH "$BASE/api/applications/$APP_ID" -d '{"branch":"develop"}' >/dev/null
BRANCH=$(curl -fsS "${H[@]}" "$BASE/api/applications/$APP_ID" | jq -r .branch)
assert_eq "develop" "$BRANCH" "branch after PATCH"

step "Delete app while enabled — expect 409"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -X DELETE "$BASE/api/applications/$APP_ID")
assert_eq "409" "$CODE" "delete while enabled"

step "Disable app"
curl -fsS "${H[@]}" -X PATCH "$BASE/api/applications/$APP_ID" -d '{"enabled":false}' >/dev/null

step "Delete app while process_state!=stopped — expect 409"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -X DELETE "$BASE/api/applications/$APP_ID")
assert_eq "409" "$CODE" "delete while not stopped"

step "Force process_state=stopped via SQL"
"${MYSQL_CMD[@]}" -e "UPDATE applications SET process_state='stopped' WHERE id=$APP_ID" >/dev/null

step "Delete app — expect 204"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -X DELETE "$BASE/api/applications/$APP_ID")
assert_eq "204" "$CODE" "delete stopped+disabled app"

step "Rotate server token"
ROTATE=$(curl -fsS "${H[@]}" -X POST "$BASE/api/servers/$SERVER_ID/rotate-token")
NEW_TOKEN=$(echo "$ROTATE" | jq -r .rawToken)
[[ "$NEW_TOKEN" != "$RAW_TOKEN" ]] || { echo "rotate returned same token"; exit 1; }

step "Delete server (no apps referencing)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -X DELETE "$BASE/api/servers/$SERVER_ID")
assert_eq "204" "$CODE" "delete server"

step "Delete group"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -X DELETE "$BASE/api/groups/$GROUP_ID")
assert_eq "204" "$CODE" "delete group"

echo -e "\n\033[1;32mALL SMOKE CHECKS PASSED\033[0m"
