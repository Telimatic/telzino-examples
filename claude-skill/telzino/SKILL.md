---
name: telzino
description: Troubleshoot and manage Telzino voice AI agents over the Telzino API — explain why a call went wrong (failed transfers, SMS, tool or integration errors), review recent calls, find reseller, organization and agent IDs, mint dashboard sign-in links, and safely change an agent's prompt, greeting, transfer rules or tools. Use whenever Telzino, a Telzino agent or AI receptionist, a Telzino call or transcript comes up.
---

# Telzino

Use this skill to work with a Telzino partner account through its API:

1. **Explain calls.** Read call logs and say what happened and why.
2. **Find things.** Look up reseller, organization and agent IDs by name.
3. **Sign in.** Mint a single-use dashboard sign-in link for a reseller or an organization.
4. **Change agents safely.** Update a prompt, greeting, transfer rules or tools, with a backup and a check after.

Everything goes through `scripts/telzino.sh` in this skill's folder. It needs `bash`, `curl` and `jq`.

## Documentation

| What | Where |
| --- | --- |
| Agent runbook | `https://docs.telzino.com/agent-runbook` |
| OpenAPI spec | `https://api.telzino.com/api-doc/openapi` |
| Postman collection | `https://api.telzino.com/api-doc/postman` |

Read the spec before writing any request body. Never invent an endpoint or a field.

## Credentials

A **partner** creates API keys in the Telzino Dashboard under **Account Settings → API Keys** (help: `https://docs.telzino.com/admin-guide/dashboard/account-settings#api-keys`). Resellers and organizations can't create keys; they ask their partner. Each key has an **Access** setting that decides what it reaches:

| Key access | What works |
| --- | --- |
| Whole account | Everything below |
| One reseller or organization | Agents, calls, history, changes inside that scope. **Not** `resellers`, `orgs` or `sso` (refused with `403 insufficient_scope`). Use `agents` to find things instead. |
| One agent | Not enough for this skill: it can't read the agent or its calls. |

Recommend the narrowest key that covers the job. `whoami` shows a key's scope.

The script finds the API key in this order:

1. `$TELZINO_ENV_FILE`
2. `TELZINO_CLIENT_ID` and `TELZINO_CLIENT_SECRET`, already exported
3. `./.telzino.env`, then `~/.telzino.env`

The file is two lines:

```bash
export TELZINO_CLIENT_ID=...
export TELZINO_CLIENT_SECRET=...
```

Rules:

- **Never print, echo or `cat` the file or the variables**, and never copy them into a script, a repository, a memory or a chat message.
- **Don't ask the user to paste the secret into the chat.** On a computer, they create `~/.telzino.env` in an editor and run `chmod 600 ~/.telzino.env`. In a Claude chat with no access to their computer, ask them to attach the file. Then set `TELZINO_ENV_FILE` to the attached file's path for each command, and don't copy it anywhere else.
- If a secret does end up in the chat, say so plainly and recommend rotating it.

`TELZINO_BASE_URL` changes the API host (default `https://beta.telzino.io`). If requests fail with a proxy or network error, the environment probably can't reach that host. Tell the user that the host has to be allowed for Claude's code execution. Don't retry it other ways.

## Commands

```bash
S=<this skill's folder>/scripts/telzino.sh
$S whoami                          # account and scope of the key
$S resellers [filter]              # resellers in the account
$S orgs <reseller-id> [filter]     # organizations under a reseller
$S agents [filter]                 # every agent: id, organization, status, name
$S agent <agent-id> [file]         # save full config as a backup, print a summary
$S calls <agent-id> [limit]        # recent calls, newest first
$S call <agent-id> <call-id>       # one call as a timeline with every tool call and result
$S tools <agent-id> [limit]        # how often each tool ran and failed, with sample errors
$S history <agent-id> [limit]      # change history: who changed which fields, when, from where
$S sso reseller|organization <id> [path]   # single-use dashboard sign-in link
```

Call IDs can be shortened to their first 8 characters.

When the user names an agent, reseller or customer, **look it up** with `agents`, `resellers` or `orgs`. Don't ask for the UUID. Names aren't unique: if more than one row matches, show the candidates and ask which one. Never take the first match. An organization with an empty `name` can often be identified by its `external_id`.

## Explaining a call

This is the most common job. Work through it in this order.

1. **Find the agent and the call.** Run `agents` to get the agent, then `calls <agent-id> 20`. Pick the call by time, caller or title. Times are UTC, so convert them to the user's time zone when you talk about them.
2. **Read the timeline.** Run `call <agent-id> <call-id>`. Each line shows seconds from the start, then who spoke: AGENT, USER, SYSTEM or TOOL.
   - **TOOL lines** show the arguments and the exact result. The reason for a failure is almost always in a result.
   - **SYSTEM lines** show transfers and their outcome, SMS sent, and how the call ended (for example "Call ended by remote party").
   - **Order matters.** An action (a transfer, an SMS) with no USER line before it means the agent acted without hearing the caller.
3. **Look for a pattern.** Run `tools <agent-id> 50` to see whether the failing tool always fails, sometimes fails, or only started failing recently. Compare the bad call with calls just before it. If every call since a certain time fails the same way, run `history <agent-id>` to see who changed what just before. **Change History doesn't record changes to tools.** So if `agent` shows an `updated_at` newer than the newest history entry, something outside the history changed, most often the agent's tools. Compare against an earlier backup if you have one.
4. **Explain it in plain words.** Say what the caller wanted, what the agent did, the exact error, the cause, and the fix. Separate what the logs prove from what you are inferring.

A dashboard share link (`https://dashboard.telzino.io/share/transcript/<id>`) shows only the spoken lines. To diagnose, find the same call through the API by agent and start time.

### Common causes

| What you see | Usual cause and fix |
| --- | --- |
| `SMS is not provisioned for extension N (no registered SMS number)` | The tool sends from the agent's PBX extension, and that extension has no SMS-enabled number. Assign one on the PBX, or have the agent text from the hosted SMS tool instead. |
| Agent uses one SMS tool and ignores another that works | Each tool's `description` tells the model when to use it. Two tools that both say "text the caller" compete. Make the descriptions distinct, or remove one. |
| `Verification failed: Incorrect PIN code` | Check the arguments first: speech-to-text often drops or changes digits ("147" for "1457"). If identical arguments failed and then succeeded, report it as intermittent. |
| Directory lookup returns no users for a known user | The user may be hidden from the PBX directory, or the search may not match full names. Try the last name or the extension, and check the user's directory settings on the PBX. |
| Transfer fails from a web test call | Expected. Transfers don't work from the dashboard's web test call. Test transfers with a real phone call. |
| Agent transfers before the caller says anything | Usually the AI greeting prompt contains a script or quoted text that the model takes as the caller's answer. Rewrite it as a plain instruction (see Greetings). |
| Calendar or integration errors (`Graph API error (502/504)`) | The upstream service failed. Check whether it happens on every call or only sometimes before changing anything. |
| Agent promises something no tool can do (a reminder text, a callback) | The model is improvising. Add a rule to the prompt saying what it can't do and what to offer instead. |

Calls on a live agent are real callers. If a recent change is breaking calls, put the previous value back first, then investigate.

## Changing an agent safely

`GET /api/v1/agents/{id}` returns the full agent. Changes go through `PUT /api/v1/agents/{id}`. On `beta.telzino.io`, API routes are served under `/api/v1/...`.

1. **Back up right before each change.** Run `agent <agent-id>`, which saves the full JSON. Someone may have edited the agent in the dashboard since you last read it. If the field you're about to change differs from what you planned against, stop and tell the user.
2. **Send only the fields you're changing, in camelCase.** A GET returns snake_case (`system_prompt`), but a PUT takes camelCase (`systemPrompt`). The PUT rejects unknown keys, so never send a GET response back as a PUT.
3. **Validate without writing.** Add one extra key such as `"__dry_run__": 1` to the body. If the only error is that unrecognized key, the rest of the body is valid and nothing was saved. Some checks only run after this one passes, so still read the result of the real PUT.
4. **Check after.** Run `agent` again and confirm that the changed fields match what you sent and nothing else changed.
5. **Watch the next few calls** with `calls` and `call`.

### Undoing a change

Every recorded settings change is in Change History. `POST /api/v1/agents/{id}/history/{versionId}/revert` restores the agent to that version (use the `id` shown by `history`, not the version number), and the revert is itself saved as a new version. Tool changes aren't in the history, so a revert won't undo them: restore tools from your backup instead.

### `config`: send the whole object

When you send `config`, send the **complete** object from the fresh backup with your one key changed. Leave out `ambient_custom_url` and `thinking_custom_url`. A partial `config` can replace the stored one and lose the other settings. Afterwards, compare the config against the backup.

### Settings only the dashboard can change

`voice_settings.ai_greeting_interruptible`, `config.ambient_custom_url` and `config.thinking_custom_url`, and some voice models. Agents also have no silence timeout, maximum duration or off-topic setting; those rules go in the system prompt.

When a change needs the dashboard, mint an organization sign-in link with `sso` and tell the user what to change.

### Greetings

| Field (GET / PUT) | Behavior |
| --- | --- |
| `greeting_message` / `greetingMessage` | Spoken word for word. Can't be interrupted. |
| `ai_greeting_prompt` / `aiGreetingPrompt` | An instruction; the model writes and speaks the greeting. Plays after the static greeting if both are set. |

Never put a script or quoted caller-like text in the AI greeting prompt. Write it as an instruction, for example: "Ask the caller which product they need help with. Keep it to one or two short sentences." For exact wording, use the static greeting.

### Silence, ending the call, staying on topic

Put these rules in the system prompt:

```
## Silence
- If the caller says nothing, ask once: "Are you still there?"
- If the caller stays silent for more than 20 seconds in total, say "<goodbye line>" and end the call.

## Off-topic conversations
- If the caller asks something unrelated, redirect once to the purpose of the call.
- If they keep going off topic, say "<goodbye line>" and end the call.
```

Before adding one, look for rules that contradict it (for example "Never end the call yourself") and replace them. Timing is the model's judgment, not a timer, so recommend a test call.

### Transfer rules

`transfer_rules` is free text. Destinations are lines like `Billing (invoices, payments) → pbx:2001`, with `pbx:<ext>` for an extension and a 10-digit number for an outside line. A `Use for: …` line describes the destination on the line above it. Every destination the prompt mentions by name must exist in the rules. If one is missing, point it out; don't make up a number.

### Transfers between agents

To hand a caller to another Telzino agent in the same organization, use the internal **transfer to agent** tool, not a PBX transfer to that agent's extension. It keeps the call on the platform and passes the conversation context. It is one tool in `extensions.tools`, with every target listed in its `transfer_targets` parameter as a **JSON-encoded string**:

```json
{
  "name": "transfer_to_agent",
  "friendlyName": "Transfer_To_Agent",
  "type": "transfer_agent",
  "url": "internal://agent-transfer",
  "method": "POST",
  "condition": "during_call",
  "headers": [{"key": "Content-Type", "value": "application/json"}],
  "parameters": [{
    "key": "transfer_targets",
    "value": "[{\"agent_id\":\"<uuid>\",\"agent_name\":\"<name>\",\"condition\":\"<when to transfer>\"}]"
  }],
  "description": "Transfer to \"<name>\" when: <condition>"
}
```

When you send `extensions`, include every existing tool, parameter and MCP server unchanged, plus your addition. If a sibling agent already has this tool, copy its shape.

### Tools and webhooks

`extensions.tools[]` holds tools the agent can call during a call. Each tool's `description` is what the model reads to decide when to use it, so it is often the real cause of "the agent used the wrong tool". `webhooks[]` fire on call events (`before_call`, `during_call`, `after_call`, `before_transfer`, `on_transfer`, `on_transfer_success`, `on_transfer_failure`, `on_error`, `on_disconnect`).

Parameter values can use only these variables: `{{call_id}}`, `{{call_summary}}`, `{{transcript}}`, `{{caller_number}}`, `{{call_duration}}`.

Adding the PBX SMS tools requires SMS Messaging to be enabled for the organization; otherwise the PUT returns 403.

### MCP servers

`extensions.mcpServers[]` entries take exactly four keys: `name`, `url`, `transport_type` (`sse` or `http`) and `auth_headers` (an array of `{key, value}`). Test the connection first with `POST /api/v1/mcp/test-connection`, which stores nothing. A failed connection returns HTTP 200 with `success: false`. An MCP server gives the agent all of its tools, so limit what the agent does with them in the system prompt.

### Test copies

To try a prompt or greeting change without touching live calls, create a copy with `POST /api/v1/agents` (`name` and `organizationId` required, camelCase fields). **Leave out SIP registration**, or the copy will take the live agent's calls. Use an IANA time zone (`America/Denver`). Test it with the dashboard's web test call, then copy only the changed field to the live agent.

## Dashboard sign-in links

`sso reseller <id>` shows every organization under that reseller; `sso organization <id>` shows just that one. A link works once and expires **5 minutes** after it is made. Mint it only when the user is ready, give it to them right away with its expiry in their local time, and remind them it stops working after the first open. The optional path argument is a dashboard path such as `/dashboard/organization/reports/call-logs`.

In the dashboard, agent prompts, tools and MCP connections aren't editable from the reseller portal; use the API for those.

Before promising anyone a shareable transcript link, note that an organization with "Secure Access" turned on blocks public transcript sharing.

## Troubleshooting the API

| Symptom | Meaning |
| --- | --- |
| HTML instead of JSON | That route doesn't exist. Check the spec. |
| `404 ... not found or access denied` | The ID belongs to a different account, or is mistyped. |
| `405` | The route exists but not for that method. Agents take PUT; only `/status` takes PATCH. |
| `unrecognized_keys` on a PUT | You sent snake_case, or a field the API can't write. |
| After a `config` PUT, only your keys remain | The config was replaced. Restore it from the backup: send the full object plus your change. |
| Sign-in link fails with `INVALID_TOKEN` | It was already opened, or is older than 5 minutes. Mint a new one. |
| `could not get an access token` | Wrong or rotated client ID or secret. |
| `403 insufficient_scope` or `forbidden` | The key is limited to one reseller, organization or agent. Run `whoami`, and use a key whose access covers the request. |
