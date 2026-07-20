import test from 'node:test';
import assert from 'node:assert/strict';
import { getInlineDialogueButtonPresentation } from '../public/lib/inline-dialogue-button.mjs';

test('inline dialogue button has distinct lifecycle states', () => {
    assert.match(getInlineDialogueButtonPresentation('idle').iconClass, /headphones/);
    assert.equal(getInlineDialogueButtonPresentation('preparing').busy, true);
    assert.match(getInlineDialogueButtonPresentation('ready').iconClass, /fa-play/);
    assert.match(getInlineDialogueButtonPresentation('playing').iconClass, /fa-pause/);
    assert.equal(getInlineDialogueButtonPresentation('playing').pressed, true);
});

test('unknown inline dialogue state safely falls back to idle', () => {
    assert.deepEqual(
        getInlineDialogueButtonPresentation('unknown'),
        getInlineDialogueButtonPresentation('idle'),
    );
});
