# Repository Guidelines

## Project Structure & Module Organization

This repository contains a SillyTavern extension. The frontend extension entry is `index.js`, with UI styles in `style.css`. `manifest.json` declares the SillyTavern extension metadata. Standalone subtitle window files are `stage.html`, `stage-window.js`, and `stage-window.css`. Optional server-side helper code lives in `server-plugin/HybridAudiobookStage-Launcher/`.

## Build, Test, and Development Commands

There is no build step. Edit the root JS/CSS/HTML files directly, then reload SillyTavern.

- `node --check index.js`: validate frontend JavaScript syntax.
- `node --check server-plugin/HybridAudiobookStage-Launcher/index.js`: validate the server helper.
- `git diff -- index.js style.css manifest.json`: review extension changes before committing.

## Coding Style & Naming Conventions

Use plain JavaScript and browser APIs. Keep existing 4-space indentation. Use camelCase for JavaScript functions and variables, and kebab-case or `has-` prefixed classes for CSS selectors. Keep SillyTavern setting keys stable because users may already have saved configuration.

## Testing Guidelines

Manual testing is required in SillyTavern. Verify extension settings, message buttons, per-dialogue buttons, pure player mode, video stage mode, shared cache status, and `多端自检`. For server helper changes, restart SillyTavern and check `/api/plugins/hybrid-audiobook-stage/probe`.

## Storage Rules

Persistent settings must use SillyTavern `extension_settings` and `saveSettingsDebounced()`. Do not store generated audio or video as base64 in settings. Use IndexedDB only as browser-local cache, and use server files for shared audio cache.

## Commit & Pull Request Guidelines

Use concise imperative commit messages, preferably with Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, or `chore:`. Pull requests should include a short summary, affected UI/workflows, manual test results, and screenshots or clips for visual changes.

## Release Workflow

For GitHub release, README, CHANGELOG, Q&A, and versioning workflow, use the `gabby-github-release-flow` Codex skill.
