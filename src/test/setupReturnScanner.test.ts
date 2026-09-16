import * as assert from 'assert';
import { scanSetupReturnHints, commentForDeclarationLine, inlineCommentOf, planSetupReturnExport } from '../parsers/setupReturnScanner';

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

    // ---- 快捷导出（planSetupReturnExport）----

    /** 按计划把编辑应用到行数组（与命令中的 WorkspaceEdit 行为一致，插入文本中的换行拆分为新行） */
    const applyExport = (lines: string[], plan: ReturnType<typeof planSetupReturnExport>): string[] => {
        assert.strictEqual(plan.kind, 'insert');
        if (plan.kind !== 'insert') { return lines; }
        const applied = lines.slice();
        if (plan.commaFixLine !== undefined) { applied[plan.commaFixLine] = applied[plan.commaFixLine].trimEnd() + ','; }
        const target = applied[plan.line];
        const updated = target.slice(0, plan.character) + plan.text + target.slice(plan.character);
        applied.splice(plan.line, 1, ...updated.split('\n'));
        return applied;
    };

    test('导出计划：按声明顺序插入（中间），逗号保持正确', () => {
        const lines = [
            'const first = 1;',
            'const second = 2;',
            'const third = 3;',
            'createApp({',
            '  setup() {',
            '    return {',
            '      first,',
            '      third,',
            '    };',
            '  },',
            '});',
        ];
        const plan = planSetupReturnExport(lines.join('\n'), 'second', 1);
        assert.strictEqual(plan.kind, 'insert');
        if (plan.kind !== 'insert') { return; }
        assert.strictEqual(plan.line, 7, '应插到 first 之后、third 之前');
        assert.strictEqual(plan.text, '      second,\n');
        assert.strictEqual(plan.commaFixLine, undefined);
        assert.deepStrictEqual(applyExport(lines, plan).slice(5, 10), [
            '    return {',
            '      first,',
            '      second,',
            '      third,',
            '    };',
        ]);
    });

    test('导出计划：末尾追加时上一项缺逗号自动补齐（避免语法错误）', () => {
        const lines = [
            'const first = 1;',
            'const last = 2;',
            'createApp({',
            '  setup() {',
            '    return {',
            '      first',
            '    };',
            '  },',
            '});',
        ];
        const plan = planSetupReturnExport(lines.join('\n'), 'last', 1);
        assert.strictEqual(plan.kind, 'insert');
        if (plan.kind !== 'insert') { return; }
        assert.strictEqual(plan.line, 6);
        assert.strictEqual(plan.commaFixLine, 5, 'first 缺少逗号，应补在第 5 行');
        assert.deepStrictEqual(applyExport(lines, plan).slice(4, 8), [
            '    return {',
            '      first,',
            '      last,',
            '    };',
        ]);
    });

    test('导出计划：已导出 exists / 未声明 not-declared / 无 return 块', () => {
        const lines = [
            'const first = 1;',
            'createApp({',
            '  setup() {',
            '    return {',
            '      first,',
            '    };',
            '  },',
            '});',
        ].join('\n');
        const exists = planSetupReturnExport(lines, 'first', 0);
        assert.strictEqual(exists.kind, 'exists');
        if (exists.kind === 'exists') { assert.strictEqual(exists.line, 4); }
        assert.strictEqual(planSetupReturnExport(lines, 'ghost', 0).kind, 'not-declared');
        assert.strictEqual(planSetupReturnExport('const a = 1;', 'a', 0).kind, 'no-return-block');
    });

    test('导出计划：单行 return 块行内插入（空块不带逗号、非空块带逗号）', () => {
        const emptyLines = ['const extra = 1;', '    return {};'];
        assert.deepStrictEqual(applyExport(emptyLines, planSetupReturnExport(emptyLines.join('\n'), 'extra', 0)), [
            'const extra = 1;',
            '    return { extra };',
        ]);
        const filledLines = ['const alpha = 1;', 'const beta = 2;', '    return { alpha };'];
        assert.deepStrictEqual(applyExport(filledLines, planSetupReturnExport(filledLines.join('\n'), 'beta', 1)), [
            'const alpha = 1;',
            'const beta = 2;',
            '    return { beta, alpha };',
        ]);
    });
});
