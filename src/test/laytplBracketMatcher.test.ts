import * as assert from 'assert';

import { findMatchingLaytplBracket } from '../parsers/laytplParser';

suite('Laytpl Bracket Matcher', () => {
    test('matches legacy if block braces across tags', () => {
        const text = [
            '{{# if(d.is_login == 1){ }}',
            '  <span>{{ d.change_time }}</span>',
            '{{# }else{ }}',
            '  <span>-</span>',
            '{{# } }}'
        ].join('\n');

        const ifOpenOffset = text.indexOf('{', text.indexOf('if('));
        const elseCloseOffset = text.indexOf('}', text.indexOf('{{# }else{ }}'));
        const elseOpenOffset = text.indexOf('{', text.indexOf('else{'));
        const finalCloseOffset = text.indexOf('}', text.indexOf('{{# } }}'));

        assert.strictEqual(findMatchingLaytplBracket(text, ifOpenOffset), elseCloseOffset);
        assert.strictEqual(findMatchingLaytplBracket(text, elseCloseOffset), ifOpenOffset);
        assert.strictEqual(findMatchingLaytplBracket(text, elseOpenOffset), finalCloseOffset);
        assert.strictEqual(findMatchingLaytplBracket(text, finalCloseOffset), elseOpenOffset);
    });

    test('matches output tag parentheses inside a single tag', () => {
        const text = '{{- include("sub-template", d) }}';
        const openOffset = text.indexOf('(');
        const closeOffset = text.indexOf(')');

        assert.strictEqual(findMatchingLaytplBracket(text, openOffset), closeOffset);
        assert.strictEqual(findMatchingLaytplBracket(text, closeOffset), openOffset);
    });

    test('matches if block brace to closing scriptlet brace instead of template delimiter', () => {
        const text = [
            "{{#if(d.type=='gr_b' && d.wx_device_id){ }}",
            '<p style="font-size: 12px;">设备ID:{{d.wx_device_id}}</p>',
            '{{# } }}'
        ].join('\n');

        const openOffset = text.indexOf('{', text.indexOf('wx_device_id)'));
        const closingTagOffset = text.indexOf('{{# } }}');
        const closeOffset = text.indexOf('}', closingTagOffset);
        const delimiterOffset = text.indexOf('}}', closingTagOffset);

        assert.strictEqual(findMatchingLaytplBracket(text, openOffset), closeOffset);
        assert.notStrictEqual(findMatchingLaytplBracket(text, openOffset), delimiterOffset);
    });

    test('ignores brackets inside no-parse tags', () => {
        const text = '{{! {{ if (d.demo) { }} !}}';
        const openOffset = text.indexOf('{', text.indexOf('if'));

        assert.strictEqual(findMatchingLaytplBracket(text, openOffset), null);
    });
});