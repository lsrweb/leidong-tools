import * as assert from 'assert';

import { findLaytplFoldingRanges } from '../providers/laytplFoldingProvider';

suite('Laytpl Folding Provider', () => {
    test('folds layui if else blocks', () => {
        const text = [
            '{{# if(d.is_login == 1){ }}',
            "  <span style='color:#67c23a'>{{d.change_time ? d.change_time : '-'}}</span>",
            '{{# }else{ }}',
            "  <span style='color:#909399'>{{d.change_time ? d.change_time : '-'}}</span>",
            '{{# } }}'
        ].join('\n');

        assert.deepStrictEqual(findLaytplFoldingRanges(text), [
            { start: 0, end: 1 },
            { start: 2, end: 3 }
        ]);
    });

    test('folds modern laytpl blocks', () => {
        const text = [
            '{{ if (d.list && d.list.length) { }}',
            '  <div>{{= d.title }}</div>',
            '{{ } else { }}',
            '  <div>无数据</div>',
            '{{ } }}'
        ].join('\n');

        assert.deepStrictEqual(findLaytplFoldingRanges(text), [
            { start: 0, end: 1 },
            { start: 2, end: 3 }
        ]);
    });

    test('supports nested layui blocks', () => {
        const text = [
            '{{# if(d.list && d.list.length){ }}',
            '  <div>',
            '    {{# for(var i = 0; i < d.list.length; i++){ }}',
            '      <span>{{ d.list[i] }}</span>',
            '    {{# } }}',
            '  </div>',
            '{{# } }}'
        ].join('\n');

        assert.deepStrictEqual(findLaytplFoldingRanges(text), [
            { start: 2, end: 3 },
            { start: 0, end: 5 }
        ]);
    });

    test('ignores output and no-parse tags for folding', () => {
        const text = [
            '{{! 这里面的 {{ if (d.demo) { }} 不应该参与折叠 !}}',
            '{{ d.title }}',
            '{{= d.desc }}',
            '{{- include("sub", d) }}',
            '{{# 这是 modern comment，不是 legacy scriptlet }}'
        ].join('\n');

        assert.deepStrictEqual(findLaytplFoldingRanges(text), []);
    });
});