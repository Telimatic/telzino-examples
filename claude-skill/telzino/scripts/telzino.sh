#!/usr/bin/env bash
#
# telzino.sh — look things up in your Telzino account, explain calls, and mint
# dashboard sign-in links.
#
# Usage:
#   telzino.sh whoami                              account and scope of your API key
#   telzino.sh resellers [filter]                  resellers in your account
#   telzino.sh orgs <reseller-id> [filter]         organizations under a reseller
#   telzino.sh agents [filter]                     every agent: id, org, status, name
#   telzino.sh agent <agent-id> [file]             save the agent's full config (backup) and summarize it
#   telzino.sh calls <agent-id> [limit]            recent calls, newest first (default 20, max 100)
#   telzino.sh call <agent-id> <call-id>           one call as a timeline, with tool calls and results
#                                                  (call-id may be the first 8 characters)
#   telzino.sh tools <agent-id> [limit]            tool calls across recent calls: how often each
#                                                  tool ran and how often it failed, with sample errors
#   telzino.sh history <agent-id> [limit]          the agent's change history: who changed what, and when
#   telzino.sh sso reseller|organization <id> [path]
#                                                  single-use dashboard sign-in link (expires in 5 minutes)
#
# Credentials (first hit wins):
#   1. $TELZINO_ENV_FILE
#   2. TELZINO_CLIENT_ID / TELZINO_CLIENT_SECRET already exported
#   3. ./.telzino.env, then ~/.telzino.env
# The env file is two lines:
#   export TELZINO_CLIENT_ID=...
#   export TELZINO_CLIENT_SECRET=...
#
# Environment:
#   TELZINO_BASE_URL   API base URL (default: https://beta.telzino.io)
#
# Requires: bash, curl, jq.

set -uo pipefail

BASE_URL="${TELZINO_BASE_URL:-https://beta.telzino.io}"
API="$BASE_URL/api/v1"
CMD="${1:-}"; [ $# -gt 0 ] && shift

usage() { awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 1; }
die() { echo "error: $*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || die "jq is required (macOS: brew install jq)"
[ -n "$CMD" ] || usage

load_creds() {
  if [ -n "${TELZINO_ENV_FILE:-}" ]; then
    [ -f "$TELZINO_ENV_FILE" ] || die "TELZINO_ENV_FILE points to a missing file"
    . "$TELZINO_ENV_FILE"
  elif [ -z "${TELZINO_CLIENT_ID:-}" ] || [ -z "${TELZINO_CLIENT_SECRET:-}" ]; then
    for f in ./.telzino.env "$HOME/.telzino.env"; do [ -f "$f" ] && { . "$f"; break; }; done
  fi
  [ -n "${TELZINO_CLIENT_ID:-}" ] && [ -n "${TELZINO_CLIENT_SECRET:-}" ] \
    || die "no credentials — create ~/.telzino.env (see the header of this script)"
}

get_token() {
  local body resp
  body=$(jq -n --arg id "$TELZINO_CLIENT_ID" --arg s "$TELZINO_CLIENT_SECRET" \
    '{grant_type:"client_credentials",client_id:$id,client_secret:$s,audience:"https://api.telzino.com/"}')
  resp=$(curl -sS --max-time 30 -X POST "$BASE_URL/oauth/token" -H 'Content-Type: application/json' -d "$body")
  TOK=$(printf '%s' "$resp" | jq -r '.access_token // empty' 2>/dev/null)
  [ -n "$TOK" ] || die "could not get an access token — check the client id and secret"
}

# GET a path, fail clearly on HTML (route does not exist) or an error body.
api() {
  local out
  out=$(curl -sS --max-time 60 "$API$1" -H "Authorization: Bearer $TOK")
  case "$out" in
    '<'*) die "$1 returned HTML — that route does not exist on $BASE_URL" ;;
  esac
  if printf '%s' "$out" | jq -e 'type=="object" and has("error")' >/dev/null 2>&1; then
    case "$out" in
      *insufficient_scope*|*forbidden*)
        echo "hint: this API key is limited to one reseller, organization or agent and can't use $1 — run 'whoami' to see its scope" >&2 ;;
    esac
    die "$1: $(printf '%s' "$out" | jq -c .)"
  fi
  printf '%s' "$out"
}

account_id() { api /me | jq -r '.account_id // empty'; }

filt() { if [ -n "${1:-}" ]; then grep -i -- "$1" || true; else cat; fi; }

# jq: turn one transcript entry into a tool event, or nothing.
# Tool calls are system entries like:
#   [Tool Call: name]\n  Arguments: {...}\n  Result: ...
JQ_TOOL='
  def toolev:
    select(.speaker=="system" and (.text|type)=="string" and (.text|test("Tool Call: ")))
    | .text as $t
    | {name: (($t|capture("Tool Call: (?<n>[A-Za-z0-9_]+)")) // {n:"?"} | .n),
       args: (($t|capture("Arguments: (?<a>[\\s\\S]*?)\\n\\s*Result:")) // {a:""} | .a | gsub("\\s+";" ")),
       result: (($t|capture("Result: (?<r>[\\s\\S]*)")) // {r:""} | .r | gsub("\\s+";" "))}
    | .failed = (.result|test("could not|cannot|failed|failure|error|not found|no users found|unable|denied|invalid|not provisioned|not enabled|unauthori[sz]ed|forbidden|timed? ?out";"i"));
'

case "$CMD" in
  whoami)
    load_creds; get_token; api /me | jq .
    ;;

  resellers)
    load_creds; get_token
    acct=$(account_id); [ -n "$acct" ] || die "could not read the account id"
    printf 'reseller_id\torgs\tname\n'
    api "/accounts/$acct/resellers" \
      | jq -r '.data[] | [.id, (.organization_count//0|tostring), (.name//"")] | @tsv' \
      | filt "${1:-}" | sort -t$'\t' -k3
    ;;

  orgs)
    [ -n "${1:-}" ] || die "usage: telzino.sh orgs <reseller-id> [filter]"
    load_creds; get_token
    printf 'organization_id\tname\texternal_id\n'
    api "/resellers/$1/organizations" \
      | jq -r '.data[] | [.id, (.name//""), (.external_id//"")] | @tsv' \
      | filt "${2:-}" | sort -t$'\t' -k2
    ;;

  agents)
    load_creds; get_token
    printf 'agent_id\torganization_id\tstatus\tname\n'
    api /agents | jq -r '.data[] | [.id, (.organization_id//""), (.status//""), (.name//"")] | @tsv' \
      | filt "${1:-}" | sort -t$'\t' -k4
    ;;

  agent)
    [ -n "${1:-}" ] || die "usage: telzino.sh agent <agent-id> [file]"
    load_creds; get_token
    out="${2:-agent-$1-$(date +%Y%m%d-%H%M%S).json}"
    json=$(api "/agents/$1") || exit 1
    printf '%s\n' "$json" > "$out"
    echo "saved full config to $out" >&2
    jq '(.data // .) | {
          name, status, updated_at,
          sip_extension: (.sip_registration_data.extension // null),
          tools: [(.extensions.tools // [])[] | (.name // .type)],
          mcp_servers: [(.extensions.mcp_servers // [])[] | {name, url, tools: ((.tools // []) | length)}],
          greeting_message, ai_greeting_prompt,
          system_prompt_chars: ((.system_prompt // "") | length),
          transfer_rules
        }' "$out"
    ;;

  calls)
    [ -n "${1:-}" ] || die "usage: telzino.sh calls <agent-id> [limit]"
    load_creds; get_token
    printf 'call_id\tstarted_utc\tsecs\tresolution\tcaller\ttitle\n'
    api "/agents/$1/call-logs?limit=${2:-20}" | jq -r '
      .data[] | [.id, (.call_started_at//""|.[0:19]), (.call_duration//""|tostring),
                 (.resolution_status//""), (.session_data.caller_id//""),
                 ((.summary_text//"") | split("\n")[0])] | @tsv'
    ;;

  call)
    [ -n "${1:-}" ] && [ -n "${2:-}" ] || die "usage: telzino.sh call <agent-id> <call-id>"
    load_creds; get_token
    api "/agents/$1/call-logs?limit=100" | jq -r --arg id "$2" "$JQ_TOOL"'
      [.data[] | select(.id|startswith($id))] as $m
      | if ($m|length)==0 then "no call starting with \($id) in the last 100 calls of this agent"
        else $m[0] as $c
        | "call \($c.id)",
          "started \($c.call_started_at)  duration \($c.call_duration)s  resolution \($c.resolution_status)",
          "caller \($c.session_data.caller_id // "?")  direction \($c.session_data.direction // "?")",
          "", "SUMMARY", ($c.summary_text // "(none)"), "", "TIMELINE (seconds from first entry)",
          ( ($c.transcript_json // []) | map(select(.is_partial != true and (.text|type)=="string")) as $e
            | ($e[0].timestamp // 0) as $t0
            | $e[]
            | (((.timestamp - $t0)|floor|tostring) | " " * (5 - length) + .) as $s
            | if (.speaker=="system" and (.text|test("Tool Call: "))) then
                ([.] | map(toolev) | .[0]) as $tv
                | "\($s)  TOOL  \($tv.name)  \(if $tv.failed then "FAILED" else "ok" end)\n         args:   \($tv.args[0:300])\n         result: \($tv.result[0:400])"
              else "\($s)  \(.speaker|ascii_upcase|.[0:6])  \(.text|gsub("\\s+";" ")|.[0:500])" end )
        end'
    ;;

  tools)
    [ -n "${1:-}" ] || die "usage: telzino.sh tools <agent-id> [limit]"
    load_creds; get_token
    api "/agents/$1/call-logs?limit=${2:-50}" | jq -r "$JQ_TOOL"'
      (.data | length) as $n
      | [.data[] as $c | ($c.transcript_json // [])[] | toolev | . + {call: ($c.id[0:8]), at: ($c.call_started_at[0:16])}]
      | group_by(.name)
      | "tool calls across the last \($n) calls (a result is FAILED when its text reads like an error)",
        "",
        (sort_by(-length)[]
         | (map(select(.failed))) as $f
         | "\(.[0].name): \(length) calls, \($f|length) failed\(if ($f|length)>0 then "  (last failure \($f|last|.at) UTC, call \($f|last|.call))" else "" end)",
           ($f | map(.result[0:160]) | unique | .[0:3][] | "    - \(.)"))'
    ;;

  history)
    [ -n "${1:-}" ] || die "usage: telzino.sh history <agent-id> [limit]"
    load_creds; get_token
    api "/agents/$1/history?limit=${2:-20}" | jq -r '
      .data[] | "v\(.version)  \(.created_at)  \(.action)\(if .reverted_from_id then " (revert of \(.reverted_from_id))" else "" end)  by \(.actor.email // .actor.id // "?") via \(.source // "?")  [id \(.id)]",
        (.changes[]? | "    \(.field): \((.before|tostring)[0:80]|gsub("\\s+";" ")) -> \((.after|tostring)[0:80]|gsub("\\s+";" "))")'
    ;;

  sso)
    kind="${1:-}"; id="${2:-}"; ret="${3:-}"
    case "$kind" in
      reseller) seg=resellers ;;
      organization|organisation|org) seg=organizations ;;
      *) die "usage: telzino.sh sso reseller|organization <id> [path]" ;;
    esac
    [ -n "$id" ] || die "usage: telzino.sh sso reseller|organization <id> [path]"
    load_creds; get_token
    body=$( [ -n "$ret" ] && jq -n --arg r "$ret" '{return_to:$r}' || echo '{}' )
    resp=$(curl -sS --max-time 30 -X POST "$API/$seg/$id/sso-url" \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$body")
    url=$(printf '%s' "$resp" | jq -r '.url // empty' 2>/dev/null)
    [ -n "$url" ] || { case "$resp" in *insufficient_scope*) echo "hint: sign-in links need a key over the whole account" >&2 ;; esac; die "no link created: $resp"; }
    echo "$url"
    echo "expires $(printf '%s' "$resp" | jq -r '.expires_at // "?"') — single use" >&2
    ;;

  *) usage ;;
esac
