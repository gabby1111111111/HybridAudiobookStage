const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { buildDoubaoUpstreamRequest, parseDoubaoNdjson } = require('./doubao-tts');
const {
    buildMinimaxRequest,
    parseMinimaxResponse,
    buildMinimaxVoiceListRequest,
    parseMinimaxVoiceListResponse,
    buildXiaomiMimoRequest,
    parseXiaomiMimoResponse,
} = require('./cloud-tts');

const MODULE_NAME = '[HybridAudiobookStage-Launcher]';
const INDEX_TTS_ROOT = process.env.HYBRID_AUDIOBOOK_INDEX_TTS_ROOT || path.join(process.cwd(), 'IndexTTS2');
const DEFAULT_BAT = process.env.HYBRID_AUDIOBOOK_INDEX_TTS_BAT || path.join(INDEX_TTS_ROOT, '启动api服务.bat');
const CACHE_SUBDIR = path.join('HybridAudiobookStage', 'audio');
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const MAX_TTS_RESPONSE_BYTES = 80 * 1024 * 1024;
const TTS_PROXY_TIMEOUT_MS = 60000;
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_INDEX_TTS_API = 'http://127.0.0.1:7880/v1/audio/speech';
const DEFAULT_INDEX_TTS_MODELS = 'http://127.0.0.1:7880/v1/models';
const DEFAULT_INDEX_TTS_VOICE_DIR = process.env.HYBRID_AUDIOBOOK_INDEX_TTS_VOICE_DIR
    || path.join(INDEX_TTS_ROOT, 'api', 'ckyp');

function listIndexTtsVoiceFiles() {
    const directory = path.resolve(DEFAULT_INDEX_TTS_VOICE_DIR);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        throw new Error('找不到 IndexTTS2 音色目录');
    }
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.wav')
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
}

function quotePowerShell(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteCmd(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeBatPath(value) {
    const requested = path.resolve(String(value || DEFAULT_BAT));
    const root = path.resolve(INDEX_TTS_ROOT);
    if (!requested.toLowerCase().startsWith(root.toLowerCase() + path.sep.toLowerCase())) {
        throw new Error('启动脚本必须位于 IndexTTS2 目录内');
    }
    if (path.extname(requested).toLowerCase() !== '.bat') {
        throw new Error('启动脚本必须是 .bat 文件');
    }
    if (!fs.existsSync(requested)) {
        throw new Error(`找不到启动脚本: ${requested}`);
    }
    return requested;
}

function getLanUrls(port = 8000) {
    const urls = [];
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
            const address = String(entry.address || '');
            if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(address)) continue;
            urls.push(`http://${address}:${port}`);
        }
    }
    return Array.from(new Set(urls));
}

function getCacheRoot(req) {
    const filesDir = req.user?.directories?.files || path.join(process.cwd(), 'data', 'default-user', 'user', 'files');
    const root = path.join(filesDir, CACHE_SUBDIR);
    fs.mkdirSync(root, { recursive: true });
    return root;
}

function validateHash(hash) {
    const value = String(hash || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error('Invalid audio cache hash');
    }
    return value;
}

function normalizeAudioExt(ext, mime = '') {
    const value = String(ext || '').replace(/^\./, '').toLowerCase();
    if (['wav', 'webm', 'mp3', 'ogg'].includes(value)) return value;
    if (/webm/i.test(mime)) return 'webm';
    if (/mpeg|mp3/i.test(mime)) return 'mp3';
    if (/ogg/i.test(mime)) return 'ogg';
    return 'wav';
}

function getAudioPath(root, hash, ext = '') {
    if (ext) return path.join(root, `${hash}.${normalizeAudioExt(ext)}`);
    const found = fs.readdirSync(root).find(name => name.startsWith(`${hash}.`) && !name.endsWith('.json'));
    return found ? path.join(root, found) : null;
}

function getMetaPath(root, hash) {
    return path.join(root, `${hash}.json`);
}

function getClientFileRef(req, filePath) {
    const userRoot = req.user?.directories?.root || path.join(process.cwd(), 'data', 'default-user');
    return path.relative(userRoot, filePath).replace(/\\/g, '/');
}

function getCacheStats(root) {
    const files = fs.existsSync(root) ? fs.readdirSync(root) : [];
    let count = 0;
    let bytes = 0;
    for (const name of files) {
        if (name.endsWith('.json')) continue;
        const stat = fs.statSync(path.join(root, name));
        count += 1;
        bytes += stat.size;
    }
    return { count, bytes };
}

function readAudioMeta(root, hash) {
    const metaPath = getMetaPath(root, hash);
    if (!fs.existsSync(metaPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
    } catch {
        return {};
    }
}

function writeAudioMeta(root, hash, meta) {
    fs.writeFileSync(getMetaPath(root, hash), JSON.stringify(meta, null, 2), 'utf8');
}

function touchAudioMeta(root, hash) {
    const meta = readAudioMeta(root, hash);
    meta.hash = hash;
    meta.lastAccessedAt = Date.now();
    writeAudioMeta(root, hash, meta);
}

function deleteAudioCacheEntry(root, hash) {
    const filePath = getAudioPath(root, hash);
    const metaPath = getMetaPath(root, hash);
    let removedBytes = 0;
    if (filePath && fs.existsSync(filePath)) {
        removedBytes += fs.statSync(filePath).size;
        fs.unlinkSync(filePath);
    }
    if (fs.existsSync(metaPath)) {
        removedBytes += fs.statSync(metaPath).size;
        fs.unlinkSync(metaPath);
    }
    return removedBytes;
}

function normalizeMaxCacheBytes(value) {
    const mb = Number(value);
    if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MAX_CACHE_BYTES;
    return Math.max(64, Math.min(102400, mb)) * 1024 * 1024;
}

function pruneCache(root, maxBytes) {
    const files = fs.existsSync(root) ? fs.readdirSync(root) : [];
    const entries = [];
    let bytes = 0;
    for (const name of files) {
        if (name.endsWith('.json')) continue;
        const filePath = path.join(root, name);
        const stat = fs.statSync(filePath);
        const hash = path.basename(name, path.extname(name));
        const meta = readAudioMeta(root, hash);
        bytes += stat.size;
        entries.push({
            hash,
            filePath,
            metaPath: getMetaPath(root, hash),
            size: stat.size,
            lastAccessedAt: Number(meta.lastAccessedAt || meta.createdAt || stat.mtimeMs || 0),
        });
    }

    entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    let removedCount = 0;
    let removedBytes = 0;
    for (const entry of entries) {
        if (bytes <= maxBytes) break;
        if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
        if (fs.existsSync(entry.metaPath)) fs.unlinkSync(entry.metaPath);
        bytes -= entry.size;
        removedCount += 1;
        removedBytes += entry.size;
    }
    return { removedCount, removedBytes, bytes };
}

function normalizeLocalIndexTtsUrl(value, fallback) {
    const text = String(value || fallback || '').trim();
    const url = new URL(text);
    const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (!isLocal) {
        throw new Error('IndexTTS2 proxy only allows localhost API URLs');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Invalid IndexTTS2 API protocol');
    }
    return url.toString();
}

function normalizeTtsProxyUrl(value) {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TTS proxy only allows http/https endpoints');
    if (url.username || url.password) throw new Error('TTS proxy endpoint must not contain credentials');
    return url.toString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TTS_PROXY_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function readLimitedResponse(upstream) {
    const declaredLength = Number(upstream.headers.get('content-length') || 0);
    if (declaredLength > MAX_TTS_RESPONSE_BYTES) throw new Error('TTS response is too large');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_TTS_RESPONSE_BYTES) throw new Error('TTS response is too large');
    return buffer;
}

async function init(router) {
    router.use(bodyParser.json({ limit: '120mb' }));

    router.post('/probe', (_req, res) => {
        return res.json({
            ok: true,
            defaultBat: DEFAULT_BAT,
            lanUrls: getLanUrls(Number(process.env.SILLYTAVERN_PORT || process.env.PORT || 8000)),
        });
    });

    router.post('/capabilities', (_req, res) => {
        return res.json({
            ok: true,
            capabilities: {
                minimaxTts: true,
                xiaomiMimoTts: true,
                sharedAudioCache: true,
            },
        });
    });

    router.post('/start-index-tts2', (req, res) => {
        try {
            const batPath = normalizeBatPath(req.body?.batPath);
            const cwd = path.dirname(batPath);
            const cmdLine = `chcp 65001 >nul & cd /d ${quoteCmd(cwd)} & call ${quoteCmd(batPath)}`;
            const command = [
                'Start-Process',
                '-FilePath', quotePowerShell('cmd.exe'),
                '-ArgumentList', quotePowerShell(`/k ${cmdLine}`),
                '-WorkingDirectory', quotePowerShell(cwd),
                '-WindowStyle', 'Normal',
            ].join(' ');
            const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
                cwd,
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
            });
            child.unref();
            console.log(MODULE_NAME, `Started IndexTTS2 API: ${batPath}`);
            return res.json({
                ok: true,
                message: '已发送启动请求；IndexTTS2 模型加载可能需要几十秒。',
                batPath,
            });
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(400).send(error.message || '启动失败');
        }
    });

    router.post('/index-tts2/models', async (req, res) => {
        try {
            const url = normalizeLocalIndexTtsUrl(req.body?.modelsUrl, DEFAULT_INDEX_TTS_MODELS);
            const upstream = await fetch(url, { method: 'GET' });
            const text = await upstream.text();
            res.status(upstream.status);
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
            return res.send(text);
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(502).send(error.message || 'IndexTTS2 models proxy failed');
        }
    });

    router.get('/index-tts2/voices', (req, res) => {
        try {
            const voices = listIndexTtsVoiceFiles();
            return res.json({ ok: true, voices, count: voices.length });
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(404).json({ ok: false, error: error.message || 'IndexTTS2 voice directory unavailable' });
        }
    });

    router.post('/index-tts2/proxy', async (req, res) => {
        try {
            const url = normalizeLocalIndexTtsUrl(req.body?.apiUrl, DEFAULT_INDEX_TTS_API);
            const payload = req.body?.payload;
            if (!payload || typeof payload !== 'object') return res.status(400).send('No IndexTTS2 payload specified');
            const upstream = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const arrayBuffer = await upstream.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            res.status(upstream.status);
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/wav');
            if (!upstream.ok) return res.send(buffer.toString('utf8'));
            return res.send(buffer);
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(502).send(error.message || 'IndexTTS2 proxy failed');
        }
    });

    router.post('/tts/probe', async (req, res) => {
        try {
            const endpoint = normalizeTtsProxyUrl(req.body?.endpoint);
            const headers = {};
            if (req.body?.apiKey) headers.Authorization = `Bearer ${String(req.body.apiKey)}`;
            const upstream = await fetchWithTimeout(endpoint, { method: 'GET', headers }, 15000);
            return res.json({ ok: true, reachable: true, status: upstream.status });
        } catch (error) {
            return res.status(502).send(error?.name === 'AbortError' ? 'TTS probe timed out' : (error.message || 'TTS probe failed'));
        }
    });

    router.post('/tts/proxy', async (req, res) => {
        try {
            const endpoint = normalizeTtsProxyUrl(req.body?.endpoint);
            const payload = req.body?.payload;
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return res.status(400).send('No TTS payload specified');
            }
            const headers = { 'Content-Type': 'application/json', Accept: 'audio/*,application/octet-stream' };
            if (req.body?.apiKey) headers.Authorization = `Bearer ${String(req.body.apiKey)}`;
            const upstream = await fetchWithTimeout(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
            });
            const buffer = await readLimitedResponse(upstream);
            res.status(upstream.status);
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/wav');
            if (!upstream.ok) return res.send(buffer.toString('utf8'));
            return res.send(buffer);
        } catch (error) {
            const message = error?.name === 'AbortError' ? 'TTS proxy timed out' : (error.message || 'TTS proxy failed');
            return res.status(502).send(message);
        }
    });

    router.post('/doubao-tts/generate', async (req, res) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TTS_PROXY_TIMEOUT_MS);
        const abortForClient = () => controller.abort();
        const abortForClosedResponse = () => {
            if (!res.writableEnded) controller.abort();
        };
        req.once('aborted', abortForClient);
        res.once('close', abortForClosedResponse);
        try {
            const request = buildDoubaoUpstreamRequest(req.body);
            const upstream = await fetch(request.url, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify(request.payload),
                signal: controller.signal,
            });
            const upstreamBuffer = await readLimitedResponse(upstream);
            if (!upstream.ok) {
                const message = upstreamBuffer.toString('utf8').slice(0, 500);
                return res.status(upstream.status).send(message || `豆包 TTS HTTP ${upstream.status}`);
            }
            const audio = parseDoubaoNdjson(upstreamBuffer.toString('utf8'), MAX_TTS_RESPONSE_BYTES);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Cache-Control', 'no-store');
            return res.send(audio);
        } catch (error) {
            const message = error?.name === 'AbortError'
                ? '豆包 TTS 请求超时'
                : (error.message || '豆包 TTS 请求失败');
            const status = /缺少|过长/.test(message) ? 400 : 502;
            return res.status(status).send(message);
        } finally {
            clearTimeout(timer);
            req.removeListener('aborted', abortForClient);
            res.removeListener('close', abortForClosedResponse);
        }
    });

    const registerCloudTtsRoute = (route, label, buildRequest, parseResponse) => {
        router.post(route, async (req, res) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TTS_PROXY_TIMEOUT_MS);
            const abortForClient = () => controller.abort();
            const abortForClosedResponse = () => {
                if (!res.writableEnded) controller.abort();
            };
            req.once('aborted', abortForClient);
            res.once('close', abortForClosedResponse);
            try {
                const request = buildRequest(req.body);
                const upstream = await fetch(request.url, {
                    method: 'POST',
                    headers: request.headers,
                    body: JSON.stringify(request.payload),
                    signal: controller.signal,
                });
                const upstreamBuffer = await readLimitedResponse(upstream);
                if (!upstream.ok) {
                    return res.status(upstream.status).send(`${label} HTTP ${upstream.status}`);
                }
                const audio = parseResponse(upstreamBuffer, MAX_TTS_RESPONSE_BYTES);
                res.setHeader('Content-Type', request.format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
                res.setHeader('Cache-Control', 'no-store');
                return res.send(audio);
            } catch (error) {
                const message = error?.name === 'AbortError'
                    ? `${label} 请求超时`
                    : (error.message || `${label} 请求失败`);
                const status = /缺少|过长|必须|不支持/.test(message) ? 400 : 502;
                return res.status(status).send(message.slice(0, 300));
            } finally {
                clearTimeout(timer);
                req.removeListener('aborted', abortForClient);
                res.removeListener('close', abortForClosedResponse);
            }
        });
    };

    registerCloudTtsRoute('/minimax-tts/generate', 'MiniMax TTS', buildMinimaxRequest, parseMinimaxResponse);
    registerCloudTtsRoute('/xiaomi-mimo-tts/generate', '小米 MiMo TTS', buildXiaomiMimoRequest, parseXiaomiMimoResponse);

    router.post('/minimax-tts/voices', async (req, res) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TTS_PROXY_TIMEOUT_MS);
        const abortForClient = () => controller.abort();
        const abortForClosedResponse = () => {
            if (!res.writableEnded) controller.abort();
        };
        req.once('aborted', abortForClient);
        res.once('close', abortForClosedResponse);
        try {
            const request = buildMinimaxVoiceListRequest(req.body);
            const upstream = await fetch(request.url, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify(request.payload),
                signal: controller.signal,
            });
            const upstreamBuffer = await readLimitedResponse(upstream);
            if (!upstream.ok) return res.status(upstream.status).send(`MiniMax 音色列表 HTTP ${upstream.status}`);
            const voices = parseMinimaxVoiceListResponse(upstreamBuffer);
            res.setHeader('Cache-Control', 'no-store');
            return res.json({ ok: true, voices });
        } catch (error) {
            const message = error?.name === 'AbortError'
                ? 'MiniMax 音色列表请求超时'
                : (error.message || 'MiniMax 音色列表请求失败');
            const status = /缺少|过长|必须/.test(message) ? 400 : 502;
            return res.status(status).send(message.slice(0, 300));
        } finally {
            clearTimeout(timer);
            req.removeListener('aborted', abortForClient);
            res.removeListener('close', abortForClosedResponse);
        }
    });

    router.post('/audio-cache/verify', (req, res) => {
        try {
            const root = getCacheRoot(req);
            const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [req.body?.hash];
            const result = {};
            for (const rawHash of hashes) {
                const hash = validateHash(rawHash);
                const filePath = getAudioPath(root, hash);
                result[hash] = !!filePath && fs.existsSync(filePath);
            }
            return res.json({ ok: true, result });
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(400).send(error.message || '缓存检测失败');
        }
    });

    router.get('/audio-cache/:hash', (req, res) => {
        try {
            const root = getCacheRoot(req);
            const hash = validateHash(req.params.hash);
            const filePath = getAudioPath(root, hash);
            if (!filePath || !fs.existsSync(filePath)) return res.sendStatus(404);
            touchAudioMeta(root, hash);
            const ext = path.extname(filePath).slice(1);
            const mime = ext === 'webm' ? 'audio/webm' : (ext === 'mp3' ? 'audio/mpeg' : (ext === 'ogg' ? 'audio/ogg' : 'audio/wav'));
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return fs.createReadStream(filePath).pipe(res);
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(400).send(error.message || '缓存读取失败');
        }
    });

    router.post('/audio-cache/upload', (req, res) => {
        try {
            const root = getCacheRoot(req);
            const hash = validateHash(req.body?.hash);
            const mime = String(req.body?.mime || 'audio/wav');
            const ext = normalizeAudioExt(req.body?.ext, mime);
            const data = String(req.body?.data || '');
            if (!data) return res.status(400).send('No audio data specified');
            const buffer = Buffer.from(data, 'base64');
            if (!buffer.length) return res.status(400).send('Empty audio data');
            if (buffer.length > MAX_UPLOAD_BYTES) return res.status(413).send('Audio cache file too large');

            const filePath = getAudioPath(root, hash, ext);
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, buffer);
            }
            const meta = {
                hash,
                engine: req.body?.meta?.engine || '',
                type: req.body?.meta?.type || '',
                character: req.body?.meta?.character || '',
                voice: req.body?.meta?.voice || '',
                mime,
                ext,
                size: buffer.length,
                createdAt: Date.now(),
                lastAccessedAt: Date.now(),
            };
            writeAudioMeta(root, hash, meta);
            const prune = pruneCache(root, normalizeMaxCacheBytes(req.body?.maxCacheMb));
            return res.json({
                ok: true,
                hash,
                path: getClientFileRef(req, filePath),
                url: `/api/plugins/hybrid-audiobook-stage/audio-cache/${hash}`,
                size: buffer.length,
                prune,
            });
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(400).send(error.message || '缓存上传失败');
        }
    });

    router.post('/audio-cache/stats', (req, res) => {
        try {
            const root = getCacheRoot(req);
            return res.json({ ok: true, ...getCacheStats(root), root, maxBytesDefault: DEFAULT_MAX_CACHE_BYTES });
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(500).send(error.message || '缓存统计失败');
        }
    });

    router.post('/audio-cache/self-test', (req, res) => {
        const root = getCacheRoot(req);
        const hash = crypto.createHash('sha256').update(`HybridAudiobookStage self-test ${Date.now()} ${Math.random()}`).digest('hex');
        const payload = Buffer.from('RIFF-HybridAudiobookStage-cache-self-test-WAVE', 'utf8');
        const filePath = getAudioPath(root, hash, 'wav');
        try {
            fs.writeFileSync(filePath, payload);
            writeAudioMeta(root, hash, {
                hash,
                engine: 'self-test',
                type: 'temporary',
                character: '',
                voice: '',
                mime: 'audio/wav',
                ext: 'wav',
                size: payload.length,
                createdAt: Date.now(),
                lastAccessedAt: Date.now(),
            });

            const foundPath = getAudioPath(root, hash);
            if (!foundPath || !fs.existsSync(foundPath)) {
                throw new Error('写入后无法找到临时缓存文件');
            }
            const readBack = fs.readFileSync(foundPath);
            if (!readBack.equals(payload)) {
                throw new Error('临时缓存文件读回内容不一致');
            }
            touchAudioMeta(root, hash);
            const removedBytes = deleteAudioCacheEntry(root, hash);
            const stats = getCacheStats(root);
            return res.json({ ok: true, hash, testBytes: payload.length, removedBytes, cacheCount: stats.count, cacheBytes: stats.bytes });
        } catch (error) {
            deleteAudioCacheEntry(root, hash);
            console.error(MODULE_NAME, error);
            return res.status(500).send(error.message || '缓存读写自测失败');
        }
    });

    router.post('/audio-cache/clear', (req, res) => {
        try {
            const root = getCacheRoot(req);
            const files = fs.existsSync(root) ? fs.readdirSync(root) : [];
            let count = 0;
            let bytes = 0;
            for (const name of files) {
                if (name.endsWith('.json')) continue;
                const hash = path.basename(name, path.extname(name));
                bytes += deleteAudioCacheEntry(root, hash);
                count += 1;
            }
            return res.json({ ok: true, count, bytes });
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(500).send(error.message || '缓存清理失败');
        }
    });

    router.post('/audio-cache/prune', (req, res) => {
        try {
            const root = getCacheRoot(req);
            const result = pruneCache(root, normalizeMaxCacheBytes(req.body?.maxCacheMb));
            return res.json({ ok: true, ...result, ...getCacheStats(root) });
        } catch (error) {
            console.error(MODULE_NAME, error);
            return res.status(500).send(error.message || '缓存清理失败');
        }
    });

    console.log(MODULE_NAME, 'Plugin loaded!');
}

async function exit() {
    console.log(MODULE_NAME, 'Plugin exited');
}

const info = {
    id: 'hybrid-audiobook-stage',
    name: 'HybridAudiobookStage Launcher',
    description: 'Provides TTS proxies and shared audio cache for the HybridAudiobookStage extension.',
};

module.exports = {
    init,
    exit,
    info,
};
