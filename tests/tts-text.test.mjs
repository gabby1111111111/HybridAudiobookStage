import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectTextSegments,
    extractContentBlock,
    extractNestedTtsLine,
    normalizeWhitespace,
    parseDialogueLine,
    stripTtsMarkdownMarkers,
} from '../public/lib/tts-text.mjs';

const sample = `outside
<content>
雨落在窗沿。她把杯子推过去。
[Alice|温柔][0.1, 0.2] | “喝一点吧。”

他没有回答。
[Bob] | 「我不渴。」
夜色更深了。
</content>
outside after`;

test('extracts only the first content block and removes markup', () => {
    const text = extractContentBlock('<content><p>第一段</p><p>第二段 &amp; 更多</p></content><content>忽略</content>');
    assert.equal(text, '第一段\n第二段 & 更多');
});

test('removes Markdown presentation markers before narration, dialogue and cache text are built', () => {
    assert.equal(stripTtsMarkdownMarkers('*但真的好听吗？*'), '但真的好听吗？');
    assert.equal(normalizeWhitespace('**加粗**、_强调_、~~删除线~~、`代码`。'), '加粗、强调、删除线、代码。');
    assert.equal(normalizeWhitespace('2 * 3，保留没有成对包裹的星号'), '2 * 3，保留没有成对包裹的星号');
    assert.equal(normalizeWhitespace('[可读标题](https://example.com)'), '可读标题');

    const result = collectTextSegments('<content>*但真的好听吗？*\n[A] | “**真的**很好听。”</content>');
    assert.deepEqual(result.segments.map(segment => segment.text), ['但真的好听吗？', '真的很好听。']);
    assert.equal(result.content.includes('*'), false);
});

test('parses the existing tagged dialogue format', () => {
    assert.deepEqual(parseDialogueLine('[Alice|温柔][0.1, 0.2] | “喝一点吧。”'), {
        character: 'Alice',
        emotionLabel: '温柔',
        emotion: '0.1,0.2',
        rawContent: '“喝一点吧。”',
        text: '喝一点吧。',
    });
    assert.equal(parseDialogueLine('普通旁白。'), null);
});

test('extracts nested TTS dialogue from chat bubble wrappers without narrating the wrapper', () => {
    const wrapped = '[外层昵称|[Alice|温柔][0.1, 0.2] | 「卡片里的台词。」]';
    assert.equal(extractNestedTtsLine(wrapped), '[Alice|温柔][0.1, 0.2] | 「卡片里的台词。」');

    const result = collectTextSegments(`<content>
<chat_bubble>${wrapped}</chat_bubble>
卡片之后的旁白。
</content>`);
    assert.deepEqual(result.segments.map(({ type, character, text }) => ({ type, character, text })), [
        { type: 'dialogue', character: 'Alice', text: '卡片里的台词。' },
        { type: 'narration', character: 'Narrator', text: '卡片之后的旁白。' },
    ]);
    assert.equal(result.segments.some(segment => segment.text.includes('外层昵称')), false);
});

test('subtracts dialogue ranges and preserves narration/dialogue order', () => {
    const result = collectTextSegments(sample, { mode: 'mixed' });
    assert.equal(result.hasContent, true);
    assert.deepEqual(result.segments.map(({ type, character, text }) => ({ type, character, text })), [
        { type: 'narration', character: 'Narrator', text: '雨落在窗沿。' },
        { type: 'narration', character: 'Narrator', text: '她把杯子推过去。' },
        { type: 'dialogue', character: 'Alice', text: '喝一点吧。' },
        { type: 'narration', character: 'Narrator', text: '他没有回答。' },
        { type: 'dialogue', character: 'Bob', text: '我不渴。' },
        { type: 'narration', character: 'Narrator', text: '夜色更深了。' },
    ]);
    assert.equal(result.dialogueRanges.length, 2);
    assert.equal(result.segments.some(segment => segment.type === 'narration' && /\[Alice/.test(segment.text)), false);
});

test('supports dialogue-only and single-voice routes', () => {
    const dialogueOnly = collectTextSegments(sample, { mode: 'dialogue-only' });
    assert.deepEqual(dialogueOnly.segments.map(segment => segment.text), ['喝一点吧。', '我不渴。']);

    const single = collectTextSegments(sample, { mode: 'single-voice' });
    assert.equal(single.segments.every(segment => segment.type === 'single'), true);
    assert.deepEqual(single.segments.map(segment => segment.text), [
        '雨落在窗沿。',
        '她把杯子推过去。',
        '喝一点吧。',
        '他没有回答。',
        '我不渴。',
        '夜色更深了。',
    ]);
});

test('handles missing, empty, repeated and dialogue-only content', () => {
    assert.equal(collectTextSegments('no tag').hasContent, false);
    assert.equal(collectTextSegments('<content>   </content>').hasContent, false);

    const repeated = collectTextSegments('<content>[A] | “一样。”\n旁白一样。\n[A] | “一样。”</content>');
    assert.deepEqual(repeated.segments.map(segment => segment.type), ['dialogue', 'narration', 'dialogue']);

    const onlyDialogue = collectTextSegments('<content>[A] | “第一句。”\n[B] | “第二句。”</content>');
    assert.deepEqual(onlyDialogue.segments.map(segment => segment.type), ['dialogue', 'dialogue']);
});
