## Goal
- Prevent the `{id}` session ID template error from any DCP plugin session API call.

## Root Cause
The runtime passes a **v1 SDK client** to plugins, but the DCP plugin imports **v2 type annotations** (`@opencode-ai/sdk/v2`). The v1 SDK's `Session` class uses URL templates with `{id}` (e.g., `/session/{id}`) and expects `path: { id: sessionID }` to resolve them. The DCP was passing `{ sessionID }` as a flat parameter, leaving `{id}` unresolved → URLs like `/session/%7Bid%7D/message` → server-side Zod validation fails.

## Fix
All 5 `client.session.*` call sites now use v1 parameter format:
- `client.session.get({ path: { id: sessionID } })` (via `safeGetSession`)
- `client.session.messages({ path: { id: sessionId } })` (3 call sites)
- `client.session.prompt({ path: { id: sessionID } })` (1 call site)

The `as any` cast is used because v2 types don't accept `path`.

## Call Sites
- `lib/state/utils.ts:72` - `safeGetSession` (dead code now, `isSubAgentSession` returns false)
- `lib/hooks.ts:236` - `prepareDcpExecution`
- `lib/messages/inject/subagent-results.ts:14` - `fetchSubAgentMessages`
- `lib/compress/search.ts:12` - `fetchSessionMessages`
- `lib/ui/notification.ts:375` - `sendIgnoredMessage`

## Relevant Files
- `/home/drvova/opencode-prod/packages/sdk/js/src/gen/sdk.gen.ts` - v1 Session class with `{id}` URLs (lines 431-701)
- `/home/drvova/opencode-prod/packages/sdk/js/src/v2/gen/sdk.gen.ts` - v2 Session2 class with `{sessionID}` URLs
- `/home/drvova/opencode-prod/packages/opencode/src/plugin/index.ts` - creates the v1 client for plugins (line 5, 25)
- `/home/drvova/opencode-prod/packages/sdk/js/src/gen/core/utils.gen.ts` - `defaultPathSerializer` only extracts from `path` (line 16-81)
