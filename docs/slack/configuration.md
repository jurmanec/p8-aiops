# Slack app

P8 posts into one Slack channel and receives two kinds of calls back: button presses, and a person's typed reply in that thread. Tokens and the signing secret stay in `.env`. They are not written here.

Posting is off until `SLACK_POST=1`. The process listens on `127.0.0.1:8787`. Slack cannot call that address, so both request URLs use one public `https` host that forwards to it.

## Process

| Name | Role |
| --- | --- |
| `SLACK_POST` | `1` posts. Any other value posts nothing. |
| `SLACK_BOT_TOKEN` | Bot token for `chat.postMessage` and `chat.update`. |
| `SLACK_CHANNEL_ID` | The one channel P8 posts into. |
| `SLACK_SIGNING_SECRET` | Checks `X-Slack-Signature` on both Slack routes. |

The signature is HMAC SHA256 of `v0:{timestamp}:{raw body}`, compared to the `v0=` header. A timestamp older than five minutes is rejected. If the secret is unset, signatures are not checked. Set it before either request URL is public. Restart the process after changing `.env`.

## App

One bot user, installed in the workspace, and a member of the channel.

| Slack setting | Value |
| --- | --- |
| Interactivity Request URL | `https://<public host>/slack/interactions` |
| Event Subscriptions | On |
| Event Subscriptions Request URL | `https://<public host>/slack/events` |

`/slack/interactions` answers Slack's `ssl_check` with an empty `200`, then accepts button payloads. Action ids are `WORKING_ON_IT`, `IGNORE_IT`, and `DONE`.

`/slack/events` answers a `url_verification` challenge with `{ "challenge": "<value>" }`. A verified URL means that challenge succeeded. It does not mean message events are being delivered.

A human reply is stored only when Slack delivers a `message` event for a thread, the line is not from a bot, and `thread_ts` matches a parent this process posted. A top-level channel message is ignored.

| Channel | Bot event | Scope Slack requires before it will send that event |
| --- | --- | --- |
| Public | `message.channels` | `channels:history` |
| Private | `message.groups` | `groups:history` |

`chat:write` is required either way. P8 does not read channel history itself. The history scopes are the gate on the event. `users:read` is required to turn a typed reply's user id into a display name before it is stored.

Adding a bot event on the app page does not change the installed token. Reinstall the app to the workspace so the new scope is granted. Inviting the bot into the channel again does not do that. If the reinstall shows a new bot token, put it in `SLACK_BOT_TOKEN` and restart.

Incoming webhooks are not used. A webhook cannot edit the parent or reply in its thread.

## Local reachability

Slack must call a public `https` host that forwards to `127.0.0.1:8787`. A quick tunnel works for demos; each new tunnel run gets a new hostname, so both request URLs must be updated and re-verified. Prefer a durable named hostname for ongoing demos. Put the channel id in `SLACK_CHANNEL_ID` (see [`.env.example`](../../.env.example)).
