# Repository Guidelines

## Project Structure & Module Organization

This repository contains the SillyTavern extension `HybridAudiobookStage`. Browser-side behavior currently lives in `index.js`, with UI styling in `style.css`. `manifest.json` declares the extension entry points. The standalone subtitle window uses `stage.html`, `stage-window.js`, and `stage-window.css`. The optional SillyTavern server helper is `server-plugin/HybridAudiobookStage-Launcher/index.js`; it provides the local TTS proxy, shared audio cache, diagnostics, and the allowlisted local launcher.

## Product Direction & Boundaries

Prioritize the lightweight TTS core before expanding the visual stage. The lightweight workflow must support selected-text or single-segment playback without opening video, CG, or subtitle-stage UI. Keep these reading routes distinct: mixed narration/dialogue, dialogue-only, one voice for all text, and user-selected text with a chosen voice.

Treat TTS engines as replaceable providers. Do not hard-code new features directly to IndexTTS2: provider adapters should own API checks, voice discovery, request formatting, synthesis, and cancellation. Narration, defaults, and individual characters must eventually be able to select different named provider profiles. Do not patch SillyTavern's native TTS as the primary implementation; core-file patches are update-fragile and are not delivered with this extension.

The native Doubao adapter is an independent implementation. Do not copy code or UI from the AFPL-licensed `st-immersive-sound` reference. Keep the upstream endpoint fixed to ByteDance's v3 unidirectional TTS service in the server helper, send APP ID / Access Key / Resource ID as the required `X-Api-*` headers, parse NDJSON audio chunks server-side, and return ordinary MP3 to the frontend adapter. Never include APP ID or Access Key in cache descriptors, Audit, logs, or user-facing error payloads.

The full audiobook and future visual/CG stage must consume the same lightweight playback queue. Keep wardrobe, route-history, image-generation, and CG plugins behind small integration events or adapters rather than importing their internal state directly.

## Build, Test, and Development Commands

There is no build step. Edit the root JS/CSS/HTML files directly.

- `node --check index.js`: validate frontend JavaScript syntax.
- `node --check server-plugin/HybridAudiobookStage-Launcher/index.js`: validate the server helper.
- `git diff -- index.js style.css manifest.json AGENTS.md`: review extension changes.

After frontend changes, sync the runtime files into SillyTavern and refresh the external SillyTavern Chrome/PWA. Restart SillyTavern on port 8000 after server-helper changes.

## Coding Style & Naming Conventions

Use plain JavaScript and native browser APIs; do not add a framework or bundler without an explicit architecture change. Keep 4-space indentation, descriptive camelCase JavaScript names, and kebab-case CSS classes with the existing `has-` prefix. Keep saved setting keys backward compatible and migrate renamed structures deliberately.

Separate synthesis speed from player playback rate. Cache descriptors must include text, provider/profile identity, model, voice, and synthesis-affecting parameters, but never API keys. Every TTS request must belong to a cancellable playback session; stale sessions must not update the player or start audio. Revoke temporary object URLs and remove listeners when stopping or replacing playback. Prefer playing the first ready segment while prefetching only the next one or two segments.

Audio cache identity must be independent of the UI entry point when the effective route is the same. Inline dialogue and full-message playback preserve character overrides. Exact or contained selected dialogue/narration text preserves segment metadata, but general selection entry points must ignore only migrated `profile-openai-legacy` character overrides and use the visible dialogue default instead; non-legacy explicit character overrides remain intact. If a selection cannot be mapped to one source segment, a migrated legacy `singleVoice` route must not hijack mixed/dialogue mode: use the visible dialogue default, while preserving `singleVoice` when the preset is actually in `single-voice` mode. Use the cache order `memory -> IndexedDB -> server -> Provider`; await the IndexedDB write before exposing a newly generated record as playable, while server upload may continue in the background. A page reload on the same origin should hit IndexedDB, and another device on the same SillyTavern user/server should fall back to the shared server cache.

Inline dialogue buttons must expose the playback lifecycle instead of remaining visually static: headphones before first preparation, busy feedback while resolving audio, play when the audio is ready, and pause while that exact line is playing. Re-rendering message controls must preserve the current-page state, and activating the same playing line again must pause/resume the active audio rather than create a replacement request.

When inline dialogue controls are rendered, proactively derive each routed segment's real synthesis descriptor and check memory, IndexedDB keys, and the server cache verification index. A confirmed cached line must render as ready before the user clicks it. Availability scans must never synthesize audio or download full server audio merely to choose an icon, and stale ready states must be invalidated when synthesis-affecting settings change.

Doubao cache identity must include the Profile id, Resource ID, Speaker ID, normalized text, and effective context text (including the routed emotion label), while excluding credentials. Doubao synthesis must still pass through `memory -> IndexedDB -> server -> Provider`, use the shared cancellable playback session, and wait for local persistence before playback begins.

The visible dialogue-default route is not necessarily the effective route because `characterOverrides[character]` has higher priority. Migrated voice maps may leave hidden overrides pointing to `profile-openai-legacy` after the user switches the dialogue default to another Provider. Surface the conflict in the lightweight route step, expose only counts in Audit, and require confirmation before removing old Index overrides. Never silently delete overrides for Doubao or other explicitly selected Providers.

## Storage Rules

Use `extension_settings[HybridAudiobookStage]` plus `saveSettingsDebounced()` for shared settings, provider profiles, routing, voice maps, and named presets. Never store generated audio, images, video, or base64 blobs in extension settings. IndexedDB is browser-local fallback cache only; shared audio and future visual assets belong in SillyTavern server files. `localStorage` is allowed only for short-lived standalone-window payloads or explicitly device-local layout state.

## Testing Guidelines

At minimum, test `<content>` extraction, dialogue parsing, every reading route, selected-text playback, provider/profile routing, request cancellation, next-segment prefetch, player controls, cache hits, chat/swipe changes, and mobile behavior. Changing volume alone must not invalidate synthesized audio. Switching chats, rerolling, starting another utterance, or closing the player must stop or invalidate old work.

## Acceptance Rules

Use `Step N` plans for non-trivial work. Each step must define command acceptance, runtime audit acceptance, and only the remaining human audio/UI check. Use `window.__hybridAudiobookStageAudit` as the stable frontend audit object when runtime work begins. Keep small fields such as `run_id`, `action`, `content_extracted`, `route_built`, `provider_ready`, `request_cancelled`, `audio_played`, `cache_source`, and `last_error`; never include chat text, API keys, cookies, or large payloads. Advance `run_id` for every user-triggered playback or provider probe, reset action-scoped fields to `pending`, and only mark `audio_played.status` successful after `audio.play()` resolves.

Command acceptance requires both `node --check` commands. Runtime acceptance should verify the served manifest/entry, the exact audit fields for the changed path, and relevant narrow endpoints such as `/probe` or `/audio-cache/self-test`. Human acceptance is reserved for voice quality, timing, mobile comfort, and whether the workflow feels natural. Do not claim runtime acceptance when SillyTavern or the selected TTS service is offline.

Provider actions must resolve the Profile from the currently visible `#has-profile-select` value, not only from a previously saved editing ID. The reserved migrated Edge Profile must remain `type: "edge"`; a visibly selected Edge Profile must never reach the OpenAI-compatible endpoint validator.

## Commit & Pull Request Guidelines

Use concise imperative Conventional Commit messages such as `feat: add selected-text playback` or `fix: cancel stale synthesis requests`. Pull requests should summarize affected routes/providers, settings migrations, cache impact, command checks, runtime evidence, and the small remaining human checks. Use `gabby-github-release-flow` for releases, README/CHANGELOG work, and versioning.

## Agent-Specific Instructions

Preserve user assets and unrelated local changes. Never clear `assets/`, audio caches, or server files during ordinary source synchronization. Browser-side code must not use `require('fs')` or write local files directly; use the narrow server helper when server persistence is required. Avoid copying large unlicensed blocks from reference projects; reimplement useful architecture unless the upstream license permits reuse.
