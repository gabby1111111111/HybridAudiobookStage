# HybridAudiobookStage：SillyTavern 轻量 TTS

HybridAudiobookStage 是一个 SillyTavern 前端扩展，核心功能是用一套简洁界面完成旁白、角色台词、单句、全文、选中文字和当前段落的语音朗读。

它支持 Edge TTS、IndexTTS2 / OpenAI 兼容接口和豆包原生 TTS，并让所有朗读入口共用同一套路由、播放队列与持久缓存。旧版视频字幕舞台仍然保留，但日常使用只需要操作“轻量 TTS”的三个步骤。

> 当前首个正式版本为 `v0.2.0`。公开接口仍在快速稳定阶段，升级前建议保留自己的 SillyTavern 设置备份。

## 主要功能

- 三步轻量配置：选择朗读方式、连接并试听、调整播放手感。
- 三种朗读模式：
  - 旁白和角色分别朗读；
  - 只读角色台词；
  - 全文使用一个声音。
- 多 Provider Profile：Edge、IndexTTS2 / OpenAI 兼容、豆包原生。
- 旁白、角色默认声音、全文声音和特定角色覆盖可以分别配置。
- 可搜索音色下拉框：支持名称、音色 ID、Locale、Gender、中文“男声/女声”等关键字。
- Edge 内置完整音色目录，优先显示简体中文男声和女声。
- 豆包内置猫箱同款男声、女声目录，也可手动填写 Speaker ID。
- IndexTTS2 可从服务器端只读发现参考音频目录中的 `.wav` 文件。
- 单句、全文、精确选区和段落共用缓存，不因入口不同而重复生成。
- 缓存顺序：内存 → IndexedDB → SillyTavern 服务器共享缓存 → TTS 服务。
- 台词按钮状态会显示未缓存、准备中、可立即播放、正在播放和失败。
- 支持暂停、继续、上一段、下一段、进度跳转、音量和播放倍速。
- 新朗读会取消旧合成请求，避免旧声音稍后“复活”。
- 自动清理朗读文本中的 Markdown 强调符号，例如 `*旁白*` 只朗读“旁白”。
- 保留纯有声书播放器、视频字幕舞台和独立字幕窗口。

## 安装

### 1. 安装前端扩展

在 SillyTavern 中打开：

```text
扩展 → 安装扩展
```

填入仓库地址：

```text
https://github.com/gabby1111111111/HybridAudiobookStage
```

也可以手动克隆到：

```text
SillyTavern/public/scripts/extensions/third-party/HybridAudiobookStage
```

安装后刷新 SillyTavern，在扩展设置中应能看到“轻量 TTS”。

### 2. 安装服务器插件（推荐）

以下功能需要服务器插件：

- 豆包原生 TTS；
- 手机通过 SillyTavern 访问 PC 上的 IndexTTS2；
- PC 与手机共享生成过的语音；
- IndexTTS2 参考音频目录发现；
- 本机 IndexTTS2 启动辅助与诊断。

将仓库中的：

```text
server-plugin/HybridAudiobookStage-Launcher
```

复制到：

```text
SillyTavern/plugins/HybridAudiobookStage-Launcher
```

然后重启 SillyTavern。只刷新网页不会重新加载服务器插件。

服务器插件可以通过环境变量配置 IndexTTS2：

```text
HYBRID_AUDIOBOOK_INDEX_TTS_ROOT
HYBRID_AUDIOBOOK_INDEX_TTS_BAT
HYBRID_AUDIOBOOK_INDEX_TTS_VOICE_DIR
```

其中 `HYBRID_AUDIOBOOK_INDEX_TTS_VOICE_DIR` 应指向存放 IndexTTS2 参考音频 `.wav` 文件的目录，例如 IndexTTS2 项目下的 `api/ckyp`。

### 3. Edge TTS 支持

Edge Profile 需要 SillyTavern 服务器中存在兼容的 Edge TTS 服务插件，并提供探测和生成接口。Edge 不依赖 IndexTTS2 后台。

## 第一次使用：只做三步

打开 SillyTavern 的扩展设置，找到“轻量 TTS”。

### 第 1 步：选择朗读方式

1. 开启“启用轻量 TTS”。
2. 在“我的朗读方案”中选择方案。
3. 在“朗读内容”中选择模式：
   - **旁白和角色分别朗读**：小说听书最常用，旁白与角色可以使用不同服务和音色；
   - **只读角色台词**：跳过旁白；
   - **全文使用一个声音**：全部正文使用同一个声音，配置最简单。
4. 为当前模式选择声音服务和音色。

音色控件可以搜索：

- Edge：输入 `zh-CN`、`Male`、`Female`、`男声`、`Yunxi` 等；
- 豆包：输入中文音色名或完整 Speaker ID；
- IndexTTS2：输入参考音频文件名，例如 `Nanami`。

每个 Profile 会记住上次选择的音色。切换到其他 Provider 再切回来时，不会串用别的服务的音色。

如果旧版本迁移留下了特定角色 IndexTTS2 覆盖，页面会显示黄色提示。特定角色覆盖优先级高于“角色默认使用”；确认后可通过“清除旧 Index 覆盖”只删除仍指向旧 Index Profile 的覆盖。

### 第 2 步：连接并试听声音

1. 在“要测试的声音服务”中选择 Profile。
2. 点击“测试连接”。
3. 在“试听文字”中输入一句话。
4. 点击“试听声音”。
5. 确认音色正确后再回到聊天页。

“测试连接”只检查服务或配置是否可用；“试听声音”才会真正生成音频。

### 第 3 步：调整播放手感

- **合成语速**：改变生成音频时的说话速度，修改后可能需要重新生成；
- **播放倍速**：只改变播放器速度，不改变音频缓存；
- **音量**：只改变播放音量，不改变音频缓存；
- **PC 和手机共用已生成声音**：建议保持开启。

完成后即可离开设置页，日常朗读不需要展开高级设置。

## 配置不同的 TTS 服务

### Edge TTS

1. 在第 1 步选择 Edge Profile。
2. 打开音色下拉框。
3. 已使用音色位于最上方。
4. 之后依次为简体中文男声、简体中文女声和其他语言音色。
5. 可以输入 Locale、Gender 或音色名称过滤。

Edge 常见音色 ID：

```text
zh-CN-XiaoxiaoNeural
zh-CN-YunxiNeural
```

### IndexTTS2 / OpenAI 兼容接口

IndexTTS2 作为 OpenAI 兼容 Profile 使用，典型配置为：

```text
接口：http://127.0.0.1:7880/v1/audio/speech
模型：index-tts2
音色：参考音频文件名，例如 default.wav
```

真正试听或朗读前需要启动 IndexTTS2 API。手机不能直接访问 PC 自己的 `127.0.0.1`，应安装服务器插件并使用 SillyTavern 服务器代理。

如果配置了 `HYBRID_AUDIOBOOK_INDEX_TTS_VOICE_DIR`，下拉框会只读列出该目录中的 `.wav` 文件；接口不可用时仍可手动添加音色 ID。

### 豆包原生 TTS

豆包 Profile 需要：

```text
APP ID
Access Key
Resource ID
Speaker ID
```

支持的资源类型包括：

```text
seed-tts-2.0
seed-icl-2.0
```

猫箱同款 `ICL_uranus_*` 音色需要 `seed-icl-2.0`。如果资源类型不匹配，页面会提示，不会偷偷修改整个 Profile。

豆包请求由 SillyTavern 服务器插件代理到固定的火山引擎 v3 单向 TTS 接口。浏览器不会直接请求豆包，也不会把 Access Key 写进缓存键或 Audit。

> APP ID、Access Key 和其他 Profile 设置保存在 SillyTavern 共享扩展设置中。界面遮罩不等于加密，请勿公开设置文件、截图或导出的 TTS 配置。

## 日常朗读入口

### 朗读全文

点击消息右上角的朗读按钮。插件只读取第一段 `<content>...</content>`，正文块外的状态栏和说明不会朗读。

### 朗读单句台词

识别到角色台词后，台词旁会出现小按钮：

- 耳机：尚无缓存；
- 转圈：正在准备；
- 播放：已有缓存，可以立即播放；
- 暂停：正在播放；
- 重试：上次失败。

点击同一条正在播放的台词会暂停，再点一次继续，不会重新生成。

### 朗读选中文字

在消息中选择文字，然后点击“朗读选中”。手机上可以长按选择文字。

### 朗读当前段落

先在目标段落中选择少量文字，再点击当前段落按钮。没有有效选区时，使用 `<content>` 中第一段可读内容。

### Markdown 显示符号

TTS 会在分段和缓存前移除用于显示的 Markdown 标记：

```text
*但真的好听吗？*  →  但真的好听吗？
**加粗文本**       →  加粗文本
~~删除线~~         →  删除线
`代码`             →  代码
```

没有成对包裹文字的普通星号会保留，例如 `2 * 3`。

## 推荐消息格式

把真正需要朗读的内容放进第一段 `<content>`：

```text
这里是状态栏，不会朗读。

<content>
夜色沿着窗沿慢慢落下来。

[角色甲|平静][0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8]|「今晚很安静。」

风吹动了窗帘。

[角色乙|轻快][0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9]|「那就出去走走吧。」
</content>

这里也不会朗读。
```

角色台词格式：

```text
[角色名|情绪][8维向量]|「台词」
```

情绪和向量可以按实际模板使用。未匹配为角色台词的正文会作为旁白。插件会先定位台词，再从旁白区间中扣除台词，避免重复朗读。

## 缓存与多设备

缓存查找顺序：

```text
内存 → IndexedDB → SillyTavern 服务器共享缓存 → Provider
```

单句、全文和精确选区只要合成输入相同，就会命中同一个缓存。缓存身份包含：

- 规范化后的文本；
- Provider 和 Profile；
- 模型；
- 音色；
- 输出格式；
- 合成语速；
- 情绪和其他影响合成的参数。

音量和播放倍速不会让缓存失效。

PC 和手机应连接同一个 SillyTavern 服务器。`localhost`、`127.0.0.1` 和 LAN 地址属于不同浏览器来源，但服务器共享缓存仍可以在连接同一服务器的设备间复用。

生成音频不会以 Base64 写入 SillyTavern 设置。浏览器本地缓存使用 IndexedDB，共享缓存使用 SillyTavern 用户文件目录。

## 常见问题

### 连接测试成功，但没有声音

继续点击“试听声音”。连接成功只表示接口或配置可达，试听才会真实合成。检查模型、音色、额度、浏览器自动播放限制和服务端错误信息。

### Edge 连接或朗读失败

确认兼容的 Edge TTS 服务器插件已经安装并运行。Edge 不需要 IndexTTS2，但需要自己的服务器生成接口。

### IndexTTS2 报 `fetch failed` 或 HTTP 502

确认 IndexTTS2 API 已启动并监听 Profile 中配置的端口。SillyTavern 在线不代表 IndexTTS2 后台在线。

### 豆包试听正常，但角色单句仍走 IndexTTS2

检查第 1 步的旧 Index 特定角色覆盖提示。特定角色覆盖高于角色默认路由；确认后清理旧 Index 覆盖，豆包或其他 Provider 覆盖不会被删除。

### 豆包提示配置完整，但试听失败

检查账户权限、额度、Resource ID 与 Speaker ID 是否匹配。`ICL_uranus_*` 音色需要 `seed-icl-2.0`。

### 刷新后又重新生成音频

确认本地 IndexedDB 没有被浏览器清理，并保持“PC 和手机共用已生成声音”开启。文本、Profile、模型、音色、合成语速或情绪不同都会生成不同缓存身份。

### 手机无法使用 PC 上的 IndexTTS2

安装服务器插件并启用酒馆服务器代理。手机无法通过自己的 `127.0.0.1` 访问 PC。

### 音色名称显示不完整

当前音色选择器使用两行显示：第一行是可读名称，第二行是 Locale、Gender 或完整音色 ID。可以直接搜索完整 ID；手机端列表使用单列全宽。

## 更完整的使用指南

请阅读：[轻量 TTS 完整使用指南](docs/轻量TTS使用指南.md)。

## 开发与验证

本项目没有构建步骤，前端使用原生 JavaScript。

```bash
node --check index.js
node --check server-plugin/HybridAudiobookStage-Launcher/index.js
node --check server-plugin/HybridAudiobookStage-Launcher/doubao-tts.js
node --test tests/*.test.mjs
```

## 隐私与安全

- 不要提交 `.env`、API Key、Access Key、Cookie、浏览器数据库或私人聊天。
- API 凭据不会进入缓存键和 Audit，但会保存在 SillyTavern 共享扩展设置中。
- TTS 服务器代理只允许受限的本机地址或固定上游，不提供任意文件系统访问。
- IndexTTS2 音色发现接口只返回配置目录中的 `.wav` 文件名，不读取音频内容。

## 许可证

当前仓库尚未附带开源许可证。在许可证明确之前，公开可见不代表允许复制、修改或再分发。
