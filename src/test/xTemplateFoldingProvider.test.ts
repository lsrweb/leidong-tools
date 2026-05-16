import * as assert from 'assert';

import { findXTemplateFoldingRanges } from '../providers/xTemplateFoldingProvider';

suite('XTemplate Folding Provider', () => {
    test('folds html tags inside text/x-template scripts', () => {
        const text = [
            '<script type="text/x-template" id="fadan-guanli">',
            '  <div class="fadan-guanli">',
            '    <el-form>',
            '      <el-form-item>',
            '        <span>{{ title }}</span>',
            '      </el-form-item>',
            '    </el-form>',
            '  </div>',
            '</script>'
        ].join('\n');

        assert.deepStrictEqual(findXTemplateFoldingRanges(text), [
            { start: 3, end: 4 },
            { start: 2, end: 5 },
            { start: 1, end: 6 },
            { start: 0, end: 7 }
        ]);
    });

    test('supports single-quoted and unquoted x-template type attributes', () => {
        const singleQuoted = [
            "<script id='foo' type='text/x-template'>",
            '  <custom-panel>',
            '    <div>内容</div>',
            '  </custom-panel>',
            '</script>'
        ].join('\n');

        const unquoted = [
            '<script id=foo type=text/x-template>',
            '  <custom-panel>',
            '    <div>内容</div>',
            '  </custom-panel>',
            '</script>'
        ].join('\n');

        assert.deepStrictEqual(findXTemplateFoldingRanges(singleQuoted), [
            { start: 1, end: 2 },
            { start: 0, end: 3 }
        ]);
        assert.deepStrictEqual(findXTemplateFoldingRanges(unquoted), [
            { start: 1, end: 2 },
            { start: 0, end: 3 }
        ]);
    });

    test('ignores normal script blocks', () => {
        const text = [
            '<script>',
            '  <div>',
            '    shouldNotFold();',
            '  </div>',
            '</script>'
        ].join('\n');

        assert.deepStrictEqual(findXTemplateFoldingRanges(text), []);
    });

    test('does not fold void or self-closing tags', () => {
        const text = [
            '<script type="text/x-template" id="foo">',
            '  <div>',
            '    <input type="text">',
            '    <custom-input />',
            '  </div>',
            '</script>'
        ].join('\n');

        assert.deepStrictEqual(findXTemplateFoldingRanges(text), [
            { start: 1, end: 3 },
            { start: 0, end: 4 }
        ]);
    });
});
