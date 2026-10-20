# Toonflow — Agent / Workflow Execution Architecture

Repo: `/Users/seiue/Workspace/Toonflow-app` (Bun 1.3.14 workspaces over `apps/*` + `packages/{nodes,tools,teams,ext}/*`). The runtime spine is the third-party SDK **`@earendil-works/pi-coding-agent`** (+ `pi-ai`, `pi-agent-core`): Toonflow builds a plugin economy on top of it instead of writing its own agent loop.

## 1. Plugin families & contracts

Everything is a **build-artifact plugin**: Vite/Bun bundles to `build/<fam>/`, dev copies to `data/<fam>/`, metadata lives in a banner comment on **line 1 of the JS file** — no runtime manifest JSON.

| Family | Artifact | Contract | Registration |
|---|---|---|---|
| `packages/nodes/*` (image/video/audio/text/director3d) | `<name>.umd.js` | `createNodeConfig({name,displayName,author,github,configRules})`; entry `src/index.vue`; externals → `window.toonflowNodeHost.*` / `toonflowTiptapHost.*` | banner `/*! toonflowNode:{…,version,readme} */` |
| `packages/tools/*` (canvas, mediaGeneration, assetOperator, askUser, browser, ffmpeg, skillOperator, webFetch, webSearch, workspace) | `<name>.tool.js` (ESM; zod externalized to `toonflow:tool-zod`) | `ToolPlugin { validateConfig(cfg), createTools(ctx): ToolDefinition[] }` (`toolScaffold/src/runtime.ts:213`) | banner `/*! toonflowTool:{meta} */` + optional 2nd line `/*! toonflowToolClient:{code,css} */` (inlined UMD UI) |
| `packages/teams/*` | `build/agents/<name>/` + `.agent.zip` | declarative `team.json` via zod `teamSchema` (members/delegates/tools/skills/knowledge, entry, cycles) | `createTeamConfig()`; `validateTeamResources` |
| `packages/ext/*` (txt, md, image, media, canvasNode) | `ext-*.umd.js` | `defineExt({id,extensions,resourceKind,load})` → Vue component in the document panel | metadata in `src/metadata.ts`, banner-embedded |
| `packages/mcp` | `build/mcp/stdio.js` + host `/mcp` | re-exposes canvas/node/media tools over Streamable HTTP (`127.0.0.1:10588`, Bearer); `skills/toonflow/SKILL.md` is the manual | banner |

**Authoring**: `bun run dev:plugins` rebuilds all families into `data/`; `create:ext` scaffolds extensions. Scaffolds are shared **Vite/Bun build configs**, not file templates: `createNodeConfig`, `createToolConfig` (Bun.build + client-UMD inlining), `createTeamConfig` (validate + zip), `createExtConfig`. `packages/nodeShared` is the shared component layer (`promptInput`, `mediaHistory`, `useNodeGeneration`), so plugins ship only their own logic.

**Node runtime API** (`packages/nodeScaffold/src/useNode.ts`): `useNode({label, icon, handles, outputs})` returns `{id, node, config, handles, outputs, nodeEvent, nodeTools, ai, ffmpeg, files}`. Ports are typed `NodeDataType = STRING|INT|FLOAT|BOOLEAN|IMAGE|MASK|VIDEO|AUDIO|MODEL|CLIP|VAE|CONDITIONING|*`, validated on connect by `isTypeCompatible` (`connection.ts`). Values are discriminated `{dataType, value}` (`values.ts`) — **media values are `{url, mimeType}` pointers**. Data is pulled, not pushed: `useNodeInputs().getTargetValues(nodeId, handleId)` walks upstream edges and reads source-node `data.outputs` (`nodeInputs.ts`).

## 2. Agent runtime (`apps/server/src/agent/**`)

`runtime/index.ts:44 run()` is one long-lived turn per session: build the model runtime (`runtime/model.ts`), load a JSONL `SessionManager`, assemble tools, subscribe to SDK events and re-emit them as an `AgentEvent` stream to the UI.

- **Tools exposed to the model**: `createAgentToolContext(cwd, config, canvas, question, workspaceAvailable)` (`tools/index.ts`) is the only host surface a plugin sees: `{files, ffmpeg(), media, canvas, question, skills, assets, browser, config, cwd, sdk}`. Built-ins: file read/write/edit/ls, `askUser`, plus grafted `memory`, `report` (subagents), `subAgent`; name collisions are hard errors.
- **Subagents**: `subAgent` → `runDelegatedAgent` → `runtime/subAgent.ts:runSubAgent()` spawns a real child `AgentSession` in a **new JSONL file** under `<ws>/.agent/sessions`, parent recorded in the session header; children report up via `report`. Result text truncates at 16 000 chars with a pointer to workspace artifacts; status ∈ running/completed/error/limited/cancelled/**inputRequired**.
- **Teams** (`teams/index.ts`): a team is *one* process with N filtered sessions, not separate agents. `createTeamRunner` gives each member a filtered tool list (`member.tools`, else all host tools), a member-scoped `teamResources` tool (list/read/write over `skills/`, `knowledge/`, `members/*.md`, root-prefix authorized), and a `delegate` tool exposing only `member.delegates` (acyclic, enforced at build). Members run sequentially via `runSubAgent`; the coordinator keeps an **in-memory** `SessionManager` so A2A follow-ups resume context; `requestInput` lets a remote member pause mid-task.
- **A2A** (`a2a/index.ts`): each team is a standard A2A agent at `/a2a/:name` (`AgentCard`, Bearer auth, `taskId` continuity, artifacts, cancel); remote agents are consumable too (`teams/remote.ts`).
- **Pause/stop/resend**: `runtime/sessions.ts` holds a process-global active-session map; `lockWorkspaceFiles` enforces one writer per session; a concurrent message gets 409 or `streamingBehavior:"steer"`. `clearQueue()` drains undelivered steering messages back into history so a stop loses nothing. History is a tree — resend re-points the leaf and appends a model-change marker, preserving the resume point.

## 3. Canvas graph → execution

The canvas is a **Vue Flow document, not a DAG executor**. `@dagrejs/dagre` appears once, in `arrangeCanvas.ts`, purely for auto-layout. No scheduler exists: each *node component* owns its generation lifecycle (`useNodeGeneration`), triggered by the user or an agent tool call; propagation is reactive `data.outputs` plus pull-reads. "Workflow" = whoever is upstream already produced a value.

The distinctive part is **who runs the tools**. The `canvas` ToolPlugin declares ~19 zod-schema ops (`getCanvas`, `findCanvasNodes`, `addNode`, `connectNodes`, `arrangeCanvas`, `nodeTools`, …), but the server only forwards them as JSON-RPC over the agent event stream (`agent/bridge/canvas.ts`; 120 s timeout, serialized queue) to the browser, where `useCanvasTools.ts` executes against **live Vue Flow state** and returns summaries. The agent therefore edits the real canvas — with node validation, undo history and asset cleanup — instead of writing canvas JSON. Node-level agent tools are discovered per node type (`nodeTools.register`, `nodeScaffold/src/nodeTools.ts`) and invoked as `node:<name>` (`node:setPrompt`, `node:setImage`). Offline (no browser) only server-side tools work; the MCP SKILL.md forbids bypassing this by editing canvas files.

## 4. Providers (`packages/providers`)

Two flat arrays in `index.ts`: `languageProviders = [tfRouter, deepSeek]`, `mediaProviders = [tfRouter, apiMart, metaso, compshare]`. A provider is a `ProviderDefinition` (`types.d.ts`): `{id,label,icon,version,apiUrl,modelsUrl?,protocol,rules,models,generateImage/generateVideo/generateAudio,processMedia?,checkForUpdates?,updateVendor?}`. Model capabilities are declarative: `type: text|image|video|audio`, `mode` (e.g. `startEndRequired`, `imageReference:N`), `durationResolutionMap`, `imageSizes/Ratios`, `voices`, `audio`. Requests normalize to `ImageRequest/VideoRequest/AudioRequest` with abstract `MediaInput = url|base64|binary`; a provider must return final `MediaAsset[]` — **no job IDs leak through** ("本层只约定完整结果；供应商内部处理轮询"). `this.tool` gives `fetch`, key-redacting `errorMessage`, `image`, `media.resizeImage`, `audio.convert`, and lazy `ffmpeg()` that throws `FFMPEG_REQUIRED/424` to trigger a user-facing install prompt. Providers are themselves installable, updatable plugins.

Credentials: `conf` (npm `conf`) at `$TOONFLOW_DATA_DIR/settings.json`, mode 0600 — `settings` (incl. `customProviders` with `apiKey`), `toolConfigs`, `nodeConfigs`, `extConfigs`, `disabledSkills`, `a2a`, `remoteConnections`.

## 5. Job execution

**No CLI spawning, no local inference, no ComfyUI** — everything is remote HTTP provider calls. `routes/ai/media/generate.ts` is one POST that hijacks the response: a keep-alive space every 20 s, then a JSON payload, so a long generation cannot be buffered or killed by intermediaries. Cancellation is `AbortController` wired to `res.close` / `req.aborted` / `socket.close` and threaded into provider `fetch`. Node-side generation uses `nodeAi.requestModel` → SSE `/api/ai/generate` and `/api/ai/media/generate`; `useNodeAi.generate()` runs a **client-side agent loop** (`pi-agent-core.runAgentLoop`, sequential tools, hard stop at 40 turns) with node-local tools — nodes are LLM agents in their own right. Server-side there is **no retry queue** (`SettingsManager.inMemory({retry:{enabled:false}})`), size caps are 100 MB, MIME is sniffed by magic bytes, and errors carry `{status, code}` (`EBUSY`, `ESTALE`, `ECOPYINCOMPLETE`).

## 6. Persistence

No database. Three filesystem layers: (a) **workspace** = the user's project dir, path-sandboxed by `resolveWorkspacePath` (rejects `..`, symlinks, Windows reserved names, realpath escapes) with in-process `lockWorkspaceFiles`; (b) **`data/`** = app level — `settings.json`, `nodes/`, `tools/`, `ext/`, `skills/`, `agents/`, `assets/` (global asset library using sha256 `revision` for optimistic concurrency → 409 `ESTALE`); (c) **sessions** = `<ws>/.agent/sessions/*.jsonl`, an append-only tree of `message` and `custom` entries (`toonflowUserMessage`, `toonflowSubAgentInfo`, `toonflowAttachments`, `toonflowTiming`, `compaction`, `branch_summary`) with token accounting in `getAgentStats`. Canvases are `*.json` marked `{toonflowCanvas:true, nodes, edges, viewport}`, validated on read; undo = 100 structural snapshots that **exclude** node data/media (`useCanvasHistory.ts`). Generated media is versioned only as per-node `assets/<nodeId>/` history plus copy-on-clone asset remapping (`canvasFiles.ts`).

## 7. Borrowable patterns

1. **Banner-comment metadata** — one `.js` file per plugin, no manifest drift, zod-validated on load; `.disabled` marker files enable/disable.
2. **Artifact-dir lifecycle** — `build/*` → `data/*` with an `initialized`/`bundled.json` revision marker allowing upgrade *and* downgrade, `requireNewerVersion` guards, no-overwrite install.
3. **Capability injection, not imports** — `ToolContext`/`ProviderContext`/`ExtContext`/`CanvasContext` hand plugins host fs/ffmpeg/media/canvas; redaction and sandboxing stay at the host boundary.
4. **The agent edits the live UI** over an RPC bridge with per-call timeouts, revision-counted queries and truncation metadata instead of dumping graph state into context.
5. **`askUser` with dynamic form fields** shared by chat agents and A2A `inputRequired` — one human-gate primitive for both.
6. **Declarative team manifests** validated at build (cycles, asset refs) with per-member least-privilege tool filtering.
7. **Streaming-in-an-envelope** (keep-alive heartbeat + terminal JSON), tagged-template i18n with zod message folding (`packages/i18n/src/index.ts:117`), and patch-based delta updates via a separate `apps/updateServer`.

**Absent**: SQLite/DB, telemetry, job queue with retries, local inference/ComfyUI, graph scheduler.
