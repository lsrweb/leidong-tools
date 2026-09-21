import * as assert from 'assert';

import { findPhpTagFoldingRanges, getPhpTagInfo } from '../parsers/phpTagParser';

suite('PHP Tag Folding Provider', () => {
    test('folds if blocks whose braces span php tags', () => {
        const text = [
            '<?php if (!$materialCenterMarkupOnly) { ?>',
            '<link rel="stylesheet" href="/assets/x.css" />',
            '<style>',
            '#app { color: red; }',
            '</style>',
            '<?php } ?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 4 }
        ]);
    });

    test('folds nested if blocks across php tags', () => {
        const text = [
            '<?php if ($a) { ?>',
            '  <div>',
            '    <?php if ($b) { ?>',
            '      <span>x</span>',
            '    <?php } ?>',
            '  </div>',
            '<?php } ?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 5 },
            { start: 2, end: 3 }
        ]);
    });

    test('folds if/else brace chain across php tags', () => {
        const text = [
            '<?php if ($a) { ?>',
            '  A',
            '<?php } else { ?>',
            '  B',
            '<?php } ?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 1 },
            { start: 2, end: 3 }
        ]);
    });

    test('folds alternative syntax blocks with else/elseif segments', () => {
        const text = [
            '<?php if ($a): ?>',
            '  A',
            '<?php elseif ($b): ?>',
            '  B',
            '<?php else: ?>',
            '  C',
            '<?php endif; ?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 1 },
            { start: 2, end: 3 },
            { start: 4, end: 5 }
        ]);
    });

    test('folds foreach/endforeach blocks', () => {
        const text = [
            '<?php foreach ($list as $item): ?>',
            '  <li><?= $item[\'name\'] ?></li>',
            '<?php endforeach; ?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 1 }
        ]);
    });

    test('folds multi-line php blocks as a whole', () => {
        const text = [
            '<?php',
            '$a = 1;',
            '$b = 2;',
            '?>',
            '<div>x</div>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 2 }
        ]);
    });

    test('ignores xml declarations and plain html', () => {
        const text = [
            '<?xml version="1.0"?>',
            '<div>x</div>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), []);
    });

    test('ignores braces inside strings, comments and heredocs', () => {
        const text = [
            '<?php',
            '$s = \'} no brace\';',
            '// } comment',
            '/* } */',
            '$h = <<<EOT',
            '} { (',
            'EOT;',
            'if ($a) {',
            '    echo $s;',
            '}',
            '?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 9 },
            { start: 7, end: 8 }
        ]);
    });

    test('does not treat brace-style switch cases as alternative syntax', () => {
        const text = [
            '<?php',
            'switch ($x) {',
            '    case 1:',
            '        echo 1;',
            '        break;',
            '    case 2:',
            '        echo 2;',
            '        break;',
            '}',
            '?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 8 },
            { start: 1, end: 7 }
        ]);
    });

    test('single-line php tags produce no folding ranges', () => {
        const singleStatement = '<?php if (!$embed) echo $header; ?>';
        assert.deepStrictEqual(findPhpTagFoldingRanges(singleStatement), []);

        const inlineEcho = '<?= $title ?>';
        assert.deepStrictEqual(findPhpTagFoldingRanges(inlineEcho), []);
    });

    test('ternary colon after control header is not alternative syntax', () => {
        const text = '<?php foreach ($a as $b) echo $x ? 1 : 0; ?>';

        assert.deepStrictEqual(getPhpTagInfo(text).altPairs, []);
        assert.deepStrictEqual(findPhpTagFoldingRanges(text), []);
    });

    test('mixed brace block and alternative syntax nest correctly', () => {
        const text = [
            '<?php if ($a) { ?>',
            '  <?php foreach ($b as $c): ?>',
            '    x',
            '  <?php endforeach; ?>',
            '<?php } ?>'
        ].join('\n');

        assert.deepStrictEqual(findPhpTagFoldingRanges(text), [
            { start: 0, end: 3 },
            { start: 1, end: 2 }
        ]);
    });
});
