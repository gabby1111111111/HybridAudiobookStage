export function stripTtsMarkdownMarkers(text) {
    let result = String(text || '');
    result = result
        .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|\/)[^)\s]+\)/g, '$1')
        .replace(/(^|\n)[ \t]{0,3}(?:#{1,6}|>)\s+/g, '$1')
        .replace(/(^|\n)[ \t]*[*+-]\s+/g, '$1');
    for (let pass = 0; pass < 3; pass += 1) {
        result = result
            .replace(/(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1/g, '$2')
            .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
            .replace(/`{1,3}([^`\n]+?)`{1,3}/g, '$1');
    }
    return result;
}

export function normalizeWhitespace(text) {
    return stripTtsMarkdownMarkers(text)
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function decodeVisibleText(value) {
    return normalizeWhitespace(String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&'));
}

export function extractContentBlock(text) {
    const source = String(text || '');
    const match = source.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);
    return match ? decodeVisibleText(match[1]) : '';
}

export function parseDialogueLine(line) {
    const trimmed = String(line || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) return null;
    const match = trimmed.match(/^\[([^\]|\n]+)(?:\|([^\]\n]*))?\](?:\[([\d.,\s-]+)\])?\s*\|\s*([「“"](.*?)[」”"])\s*$/);
    if (!match) return null;

    const character = (match[1] || '').trim();
    const emotionLabel = (match[2] || '').trim();
    const emotion = match[3] ? match[3].replace(/\s/g, '') : null;
    const rawContent = (match[4] || '').trim();
    const spokenText = (match[5] || '').trim();
    if (!character || !spokenText) return null;
    return { character, emotionLabel, emotion, rawContent, text: spokenText };
}

export function splitNarrationText(text) {
    const normalized = normalizeWhitespace(text).replace(/[ \t]+/g, ' ');
    if (!normalized) return [];

    const chunks = [];
    for (const paragraph of normalized.split(/\n+/)) {
        let buffer = '';
        for (const char of paragraph.trim()) {
            buffer += char;
            if (/[。！？；!?;]/.test(char)) {
                chunks.push(buffer.trim());
                buffer = '';
            }
        }
        if (buffer.trim()) chunks.push(buffer.trim());
    }
    return chunks.filter(Boolean);
}

function findDialogueRanges(content) {
    const ranges = [];
    const linePattern = /[^\n]*(?:\n|$)/g;
    let match;
    while ((match = linePattern.exec(content)) !== null) {
        if (!match[0] && linePattern.lastIndex >= content.length) break;
        const lineWithBreak = match[0];
        const line = lineWithBreak.replace(/\n$/, '');
        const parsed = parseDialogueLine(line);
        if (parsed) {
            const leading = line.length - line.trimStart().length;
            const trailing = line.length - line.trimEnd().length;
            ranges.push({
                start: match.index + leading,
                end: match.index + line.length - trailing,
                originalLine: line.trim(),
                ...parsed,
            });
        }
        if (linePattern.lastIndex >= content.length) break;
    }
    return ranges;
}

function buildMixedSegments(content) {
    const dialogueRanges = findDialogueRanges(content);
    const segments = [];
    let cursor = 0;

    const pushNarrationRange = (start, end) => {
        const rangeText = content.slice(start, end);
        for (const text of splitNarrationText(rangeText)) {
            segments.push({ type: 'narration', character: 'Narrator', text });
        }
    };

    for (const dialogue of dialogueRanges) {
        pushNarrationRange(cursor, dialogue.start);
        segments.push({
            type: 'dialogue',
            text: dialogue.text,
            rawContent: dialogue.rawContent,
            character: dialogue.character,
            emotionLabel: dialogue.emotionLabel,
            emotion: dialogue.emotion,
            originalLine: dialogue.originalLine,
        });
        cursor = dialogue.end;
    }
    pushNarrationRange(cursor, content.length);
    return { segments, dialogueRanges };
}

export function collectTextSegments(rawText, { mode = 'mixed' } = {}) {
    const content = extractContentBlock(rawText);
    if (!content) {
        return { hasContent: false, content: '', segments: [], dialogueRanges: [] };
    }

    const mixed = buildMixedSegments(content);
    let segments = mixed.segments;
    if (mode === 'dialogue-only') {
        segments = segments.filter(segment => segment.type === 'dialogue');
    } else if (mode === 'single-voice') {
        segments = segments.map(segment => ({
            type: 'single',
            character: '',
            text: segment.text,
            sourceType: segment.type,
        }));
    }

    return {
        hasContent: true,
        content,
        segments,
        dialogueRanges: mixed.dialogueRanges.map(({ start, end, character }) => ({ start, end, character })),
    };
}
