#!/usr/bin/env bash
# Creates (or, with --reset, re-creates) the dedicated `cams` admin user on the
# camera and writes the cams-cameras Secret the app reads. Never prints
# credentials.
#   usage: scripts/create-camera-user.sh [--reset] [env-file]
#          (env-file defaults to ~/Development/reolink/.env)
# Needs REOLINK_IP and REOLINK_PASSWORD (the camera's own admin) in the env file.
#
# Without --reset, an existing `cams` user is left alone: the script exits
# non-zero and neither the camera nor the Secret is changed (a re-run would
# otherwise give the camera a new password the running pod doesn't have).
# With --reset it deletes the user, adds it with a new password, verifies that
# the new password can sign in, and only then writes the Secret. The running
# pod still holds the old password after that, so the script then restarts
# the cams Knative service (if it exists) by bumping a template annotation.
set -euo pipefail
RESET=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) ARGS+=("$arg") ;;
  esac
done
if [ "${#ARGS[@]}" -gt 1 ]; then echo "usage: $0 [--reset] [env-file]" >&2; exit 2; fi
ENV_FILE="${ARGS[0]:-$HOME/Development/reolink/.env}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-config}"
set -a; . "$ENV_FILE"; set +a
: "${REOLINK_IP:?missing}"; : "${REOLINK_PASSWORD:?missing}"
CAMS_CAMERA_PASSWORD=$(python3 -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(24)))')
export REOLINK_IP REOLINK_PASSWORD CAMS_CAMERA_PASSWORD RESET
python3 - <<'PY'
import json, os, ssl, urllib.request
ip = os.environ["REOLINK_IP"]; ctx = ssl._create_unverified_context()
def call(cmd, param, token=None):
    url = f"https://{ip}/cgi-bin/api.cgi?cmd={cmd}" + (f"&token={token}" if token else "")
    body = json.dumps([{"cmd": cmd, "action": 0, "param": param}]).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, context=ctx, timeout=20))[0]
def login(user, pw):
    r = call("Login", {"User": {"Version": "0", "userName": user, "password": pw}})
    if r.get("code") != 0: raise SystemExit(f"login as {user} failed: rspCode {r.get('error',{}).get('rspCode')}")
    return r["value"]["Token"]["name"]
admin = login("admin", os.environ["REOLINK_PASSWORD"])
try:
    users = [u["userName"] for u in call("GetUser", {}, admin)["value"]["User"]]
    if "cams" in users:
        if os.environ["RESET"] != "1":
            raise SystemExit("a cams user already exists on the camera; nothing was changed.\n"
                             "Re-run with --reset to replace its password (and the cams-cameras Secret).")
        r = call("DelUser", {"User": {"userName": "cams"}}, admin)
        if r.get("code") != 0: raise SystemExit(f"DelUser failed: {r.get('error')}")
        print("removed existing cams user")
    r = call("AddUser", {"User": {"userName": "cams", "password": os.environ["CAMS_CAMERA_PASSWORD"], "level": "admin"}}, admin)
    if r.get("code") != 0: raise SystemExit(f"AddUser failed: {r.get('error')}")
    print("created cams user (level admin)")
finally:
    call("Logout", {}, admin)
t = login("cams", os.environ["CAMS_CAMERA_PASSWORD"])
info = call("GetDevInfo", {}, t)["value"]["DevInfo"]
print("verified: cams can read", info["model"], info["firmVer"])
call("Logout", {}, t)
PY
python3 - <<'PY' | kubectl -n cams create secret generic cams-cameras --from-file=cameras.json=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
import json, os
print(json.dumps([{"id": "cam1", "name": "Den", "host": os.environ["REOLINK_IP"], "protocol": "https",
                   "tlsServername": "cam1.skylar.technology", "user": "cams", "password": os.environ["CAMS_CAMERA_PASSWORD"]}]))
PY
kubectl -n cams describe secret cams-cameras | sed -n '/^Data/,$p'
if [ "$RESET" = 1 ]; then
  echo "The running cams pod still holds the old camera password. Restarting the service:"
  PATCH="{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"cams.skylar.technology/restartedAt\":\"$(date -u +%FT%TZ)\"}}}}}"
  echo "  kubectl -n cams patch ksvc cams --type merge -p '$PATCH'"
  if kubectl -n cams get ksvc cams >/dev/null 2>&1; then
    kubectl -n cams patch ksvc cams --type merge -p "$PATCH"
  else
    echo "ksvc cams not found in namespace cams; not restarting. Run the command above once it exists."
  fi
fi
