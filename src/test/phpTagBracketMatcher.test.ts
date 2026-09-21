import * as assert from 'assert';

import { findMatchingPhpBracket, getPhpTagInfo, scanPhpTags } from '../parsers/phpTagParser';

suite('PHP Tag Bracket Matcher', () => {
    test('matches if block braces across php tags', () => {
        const text = [
            '<?php if (!$materialCenterEmbed) { ?>',
            '<link rel="stylesheet" href="/assets/x.css" />',
            '<?php } ?>'
        ].join('\n');

        const openOffset = text.indexOf('{');
        const closeOffset = text.indexOf('}', text.indexOf('<?php } ?>') + 5);

        assert.strictEqual(findMatchingPhpBracket(text, openOffset), closeOffset);
        assert.strictEqual(findMatchingPhpBracket(text, closeOffset), openOffset);
    });

    test('matches if/else brace chain across php tags', () => {
        const text = [
            '<?php if ($a) { ?>',
            '  A',
            '<?php } else { ?>',
            '  B',
            '<?php } ?>'
        ].join('\n');

        const ifOpenOffset = text.indexOf('{');
        const elseCloseOffset = text.indexOf('}', text.indexOf('} else {'));
        const elseOpenOffset = text.indexOf('{', text.indexOf('} else {'));
        const finalCloseOffset = text.lastIndexOf('}');

        assert.strictEqual(findMatchingPhpBracket(text, ifOpenOffset), elseCloseOffset);
        assert.strictEqual(findMatchingPhpBracket(text, elseCloseOffset), ifOpenOffset);
        assert.strictEqual(findMatchingPhpBracket(text, elseOpenOffset), finalCloseOffset);
        assert.strictEqual(findMatchingPhpBracket(text, finalCloseOffset), elseOpenOffset);
    });

    test('matches parens and brackets inside a single tag', () => {
        const text = '<?php foo($a[\'k\'], count($list)); ?>';

        const parenOpen = text.indexOf('(');
        const parenClose = text.lastIndexOf(')');
        const bracketOpen = text.indexOf('[');
        const bracketClose = text.indexOf(']');

        assert.strictEqual(findMatchingPhpBracket(text, parenOpen), parenClose);
        assert.strictEqual(findMatchingPhpBracket(text, bracketOpen), bracketClose);
    });

    test('does not match html/css braces between php tags', () => {
        const text = [
            '<?php if ($a) { ?>',
            '#app { color: red; }',
            '<?php } ?>'
        ].join('\n');

        const cssOpenOffset = text.indexOf('{', text.indexOf('#app'));
        const cssCloseOffset = text.indexOf('}', cssOpenOffset);

        assert.strictEqual(findMatchingPhpBracket(text, cssOpenOffset), null);
        assert.strictEqual(findMatchingPhpBracket(text, cssCloseOffset), null);
    });

    test('ignores brackets inside php strings and comments', () => {
        const text = '<?php $s = \'( not a paren\'; // [ also not ]' + '\n' + 'if ($a) { echo $s; } ?>';

        const stringParenOffset = text.indexOf('(');
        const commentBracketOffset = text.indexOf('[');
        const braceOpenOffset = text.indexOf('{');
        const braceCloseOffset = text.indexOf('}');

        assert.strictEqual(findMatchingPhpBracket(text, stringParenOffset), null);
        assert.strictEqual(findMatchingPhpBracket(text, commentBracketOffset), null);
        assert.strictEqual(findMatchingPhpBracket(text, braceOpenOffset), braceCloseOffset);
    });

    test('matches alternative syntax keywords (if/endif)', () => {
        const text = [
            '<?php if ($a): ?>',
            '  A',
            '<?php endif; ?>'
        ].join('\n');

        const info = getPhpTagInfo(text);
        assert.strictEqual(info.altPairs.length, 1);

        const pair = info.altPairs[0];
        assert.strictEqual(pair.kind, 'if');
        assert.strictEqual(pair.open.text, 'if');
        assert.strictEqual(pair.close.text, 'endif');
        assert.strictEqual(pair.open.offset, text.indexOf('if'));
        assert.strictEqual(pair.close.offset, text.indexOf('endif'));
    });

    test('matches nested alternative syntax keywords', () => {
        const text = [
            '<?php if ($a): ?>',
            '  <?php foreach ($list as $item): ?>',
            '    <li>x</li>',
            '  <?php endforeach; ?>',
            '<?php endif; ?>'
        ].join('\n');

        const info = getPhpTagInfo(text);
        assert.strictEqual(info.altPairs.length, 2);
        assert.strictEqual(info.altPairs[0].close.text, 'endforeach');
        assert.strictEqual(info.altPairs[1].close.text, 'endif');
    });

    test('scans php tag markers including short echo tags', () => {
        const text = '<div title="<?= $title ?>"><?= $name ?></div><?php echo 1; ?>';

        const tags = scanPhpTags(text);
        assert.strictEqual(tags.length, 3);

        const echoTag = tags[0];
        assert.strictEqual(text.slice(echoTag.openMarkerStart, echoTag.openMarkerEnd), '<?=');
        assert.strictEqual(text.slice(echoTag.closeMarkerStart, echoTag.closeMarkerStart + 2), '?>');
        assert.strictEqual(echoTag.end, echoTag.closeMarkerStart + 2);
    });

    test('recognizes uppercase php openers and ignores xml declarations', () => {
        const tags = scanPhpTags('<?PHP echo 1; ?><?xml version="1.0"?>');
        assert.strictEqual(tags.length, 1);
        assert.strictEqual(tags[0].openMarkerEnd, 5);
    });

    test('unterminated php tag extends to end of text', () => {
        const text = '<?php echo \'unclosed\';';
        const tags = scanPhpTags(text);

        assert.strictEqual(tags.length, 1);
        assert.strictEqual(tags[0].closeMarkerStart, -1);
        assert.strictEqual(tags[0].end, text.length);
    });

    test('php code inside strings does not create nested tags', () => {
        const text = '<?php $s = \'<?php } ?>\'; ?>';
        const tags = scanPhpTags(text);

        assert.strictEqual(tags.length, 1);
        assert.strictEqual(tags[0].closeMarkerStart, text.length - 2);
    });

    test('variable and member identifiers named like keywords are ignored', () => {
        const text = [
            '<?php',
            '$if = 1;',
            '$obj->case = 2;',
            'if ($if) { echo $obj->case; }',
            '?>'
        ].join('\n');

        const info = getPhpTagInfo(text);
        assert.deepStrictEqual(info.altPairs, []);

        const braceOpenOffset = text.indexOf('{');
        const braceCloseOffset = text.indexOf('}');
        assert.strictEqual(findMatchingPhpBracket(text, braceOpenOffset), braceCloseOffset);
    });
});
