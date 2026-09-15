import * as assert from 'assert';
import { scanSetupReturnHints, commentForDeclarationLine, inlineCommentOf } from '../parsers/setupReturnScanner';

/**
 * setup return 块幽灵文本扫描器测试（Inlay Hint 数据源，纯文本扫描）。
 */
suite('Setup Return Scanner', () => {
    test('return 块内各项：行尾注释/上方注释收录，无注释与行内已有注释不生成', () => {
        const lines = [
            'const getRobotIcon = (type) => type; // 机器人图标',
            '// 切换子账号选中',
            'const handleAccountSelection = (rows) => { rows; };',
            'const plain = 1;',
            'const noted = 2;',
            'const app = createApp({',
            '  setup() {',
            '    return {',
            '      getRobotIcon,',
            '      handleAccountSelection,',
            '      plain,',
            '      noted, // 已有行内注释',
            '    };',
            '  },',
            '});',
        ];
        const hints = scanSetupReturnHints(lines.join('\n'));
        assert.deepStrictEqual(
            hints.map(hint => ({ line: hint.line, character: hint.character, doc: hint.doc })),
            [
                { line: 8, character: lines[8].trimEnd().length, doc: '机器人图标' },
                { line: 9, character: lines[9].trimEnd().length, doc: '切换子账号选中' },
            ],
        );
    });

    test('嵌套对象内的项不生成（仅收集顶层 shorthand）', () => {
        const text = [
            'const top = 1; // 顶层',
            'const nested = 2; // 嵌套',
            'createApp({',
            '  setup() {',
            '    return {',
            '      top,',
            '      child: {',
            '        nested,',
            '      },',
            '    };',
            '  },',
            '});',
        ].join('\n');
        const hints = scanSetupReturnHints(text);
        assert.strictEqual(hints.length, 1, '只应生成顶层项的幽灵文本');
        assert.strictEqual(hints[0].doc, '顶层');
        assert.strictEqual(hints[0].line, 5);
    });

    test('嵌套函数内同名局部声明不抢占（取更外层的声明）', () => {
        const text = [
            'const selectedIds = ref([]); // 已选素材 ID 列表',
            'createApp({',
            '  setup() {',
            '    const doSomething = () => {',
            '      const selectedIds = computeIds();',
            '      return selectedIds;',
            '    };',
            '    return {',
            '      selectedIds,',
            '      doSomething,',
            '    };',
            '  },',
            '});',
        ].join('\n');
        const hints = scanSetupReturnHints(text);
        assert.strictEqual(hints.length, 1, '只应为 selectedIds 生成幽灵文本');
        assert.strictEqual(hints[0].line, 8);
        assert.strictEqual(hints[0].doc, '已选素材 ID 列表', '应命中更外层的顶层声明注释');
    });

    test('声明注释：行尾优先；上方 #region 标记不作为注释', () => {
        assert.strictEqual(commentForDeclarationLine(['const a = 1; // 行尾', 'const b = 2;'], 0), '行尾');
        assert.strictEqual(commentForDeclarationLine(['// #region 工具', 'const fn = () => {};'], 1), undefined);
        assert.strictEqual(commentForDeclarationLine(['// 第一行', '// 第二行', 'const fn = () => {};'], 2), '第一行 第二行');
    });

    test('行内注释提取跳过字符串中的 //', () => {
        assert.strictEqual(inlineCommentOf(`const url = 'http://a'; // 注释`), '注释');
        assert.strictEqual(inlineCommentOf(`const url = 'http://a';`), undefined);
    });
});
