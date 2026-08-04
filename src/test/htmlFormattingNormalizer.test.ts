import * as assert from 'assert';

import { normalizeInvalidVoidEndTags } from '../parsers/htmlFormattingNormalizer';

suite('HTML Formatting Normalizer', () => {
    test('converts invalid void element end tags', () => {
        assert.strictEqual(
            normalizeInvalidVoidEndTags('第一行</br>第二行</BR >第三行</img>'),
            '第一行<br />第二行<br />第三行<img />'
        );
    });

    test('does not rewrite comments or quoted attributes', () => {
        const source = '<!-- keep </br> --><div title="keep </br>">内容</div>';
        assert.strictEqual(normalizeInvalidVoidEndTags(source), source);
    });

    test('keeps ordinary closing tags unchanged', () => {
        const source = '<div><span>内容</span></div>';
        assert.strictEqual(normalizeInvalidVoidEndTags(source), source);
    });
});
