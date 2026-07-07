# Changelog

## [Unreleased]

### Added
- Added mixed audiobook playback for `<content>` narration and tagged character dialogue.
- Added floating video subtitle stage and compact pure audiobook player.
- Added per-dialogue playback buttons and full-message playback controls.
- Added SillyTavern server shared audio cache for multi-device reuse.
- Added server proxy support for local IndexTTS2 API access from mobile browsers.
- Added multi-device self-check for LAN address, shared cache read/write, Edge TTS, and IndexTTS2.

### Changed
- Kept large audio data out of shared settings; audio is stored in IndexedDB and optional server files.
- Shared cache reads now bypass browser HTTP cache so server cache state is checked directly.

### Fixed
- Fixed long subtitle display by splitting text into pages instead of relying on truncation.
- Fixed repeated playback issues by using one active audio element for the mixed queue.
