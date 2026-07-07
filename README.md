# HybridAudiobookStage

HybridAudiobookStage is a SillyTavern extension for mixed audiobook playback. It reads the first `<content>...</content>` block, sends narration to Edge TTS, sends tagged character dialogue to IndexTTS2, and can show synchronized subtitles in a floating video stage or a compact audiobook player.

## Features

- Pure audiobook mode with a compact player.
- Video subtitle stage with draggable and resizable floating UI.
- `<content>` extraction so metadata outside the story body is ignored.
- Character dialogue format: `[角色|情绪][8维向量]|「台词」`.
- Edge TTS narration and IndexTTS2 character dialogue in one ordered queue.
- Per-dialogue play buttons and full-message playback.
- Server shared audio cache for PC and mobile reuse.
- SillyTavern server proxy for local IndexTTS2 API access from mobile devices.
- Multi-device self-check for LAN URL, shared cache, Edge TTS, and IndexTTS2 status.

## Installation

Copy the frontend extension folder to:

```text
SillyTavern/public/scripts/extensions/third-party/HybridAudiobookStage
```

For shared cache, IndexTTS2 proxy, and one-click local launcher support, also copy:

```text
server-plugin/HybridAudiobookStage-Launcher
```

to:

```text
SillyTavern/plugins/HybridAudiobookStage-Launcher
```

Restart SillyTavern after installing or changing the server plugin.

## Configuration

Open SillyTavern extension settings and find `🎧 混合有声书舞台`.

- Set `IndexTTS2 接口地址`, usually `http://127.0.0.1:7880/v1/audio/speech`.
- Set `Edge 旁白音色`, for example `zh-CN-XiaoxiaoNeural`.
- Add character voices in `角色音色`, such as `萧凡 -> xiaofan.wav`.
- Use `多端自检` to verify LAN address, shared cache, Edge TTS, and IndexTTS2.

The optional launcher can be configured with environment variables:

```text
HYBRID_AUDIOBOOK_INDEX_TTS_ROOT
HYBRID_AUDIOBOOK_INDEX_TTS_BAT
```

## Usage

Write story content inside `<content>`:

```text
<content>
书房里的空气安静下来。
[萧凡|平静][0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]|「我知道了。」
</content>
```

Click the message playback button to play the whole floor, or click the small dialogue button beside a tagged line to generate and play one sentence.

## Storage Notes

Settings are saved in SillyTavern shared extension settings. Audio is not stored as base64 settings data. Generated audio is cached in browser IndexedDB and, when enabled, in the SillyTavern server shared cache under user files.

Use the same SillyTavern server address on all devices, preferably the LAN URL shown by `多端自检`, such as `http://192.168.x.x:8000`.

## Troubleshooting

- If mobile cannot generate IndexTTS2 audio, enable `通过酒馆服务器代理 IndexTTS2`.
- If settings appear different between PC and phone, confirm both devices use the same SillyTavern server URL.
- If audio cache seems stale, use `多端自检`, `缓存统计`, and `按上限清理`.
- If Edge narration fails, confirm the SillyTavern Edge TTS server plugin is installed and running.
