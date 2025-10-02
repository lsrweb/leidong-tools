/**
 * @file testJSSymbolParser.ts
 * @description JS 符号解析器测试
 */
import * as vscode from 'vscode';
import { JSSymbolParser, SymbolType } from '../parsers/jsSymbolParser';

const testVueCode = `
// Vue 2 Options API 示例
new Vue({
    el: '#app',
    data: {
        message: 'Hello Vue!',
        count: 0,
        user: {
            name: 'John',
            age: 30
        }
    },
    computed: {
        doubleCount() {
            return this.count * 2;
        },
        fullInfo: function() {
            return this.user.name + ' - ' + this.user.age;
        }
    },
    methods: {
        increment() {
            this.count++;
        },
        decrement: function() {
            this.count--;
        },
        greet(name) {
            console.log('Hello, ' + name);
        }
    },
    watch: {
        count(newVal, oldVal) {
            console.log('Count changed:', oldVal, '->', newVal);
        }
    }
});
`;

const testESCode = `
// ES6+ 语法示例
class UserService {
    constructor(config) {
        this.config = config;
        this.users = [];
    }

    async fetchUsers() {
        const response = await fetch('/api/users');
        this.users = await response.json();
        return this.users;
    }

    getUserById(id) {
        return this.users.find(u => u.id === id);
    }
}

const config = {
    apiUrl: 'https://api.example.com',
    timeout: 5000
};

function initApp() {
    const service = new UserService(config);
    return service;
}

const helpers = {
    formatDate(date) {
        return date.toISOString();
    },
    parseJSON(str) {
        try {
            return JSON.parse(str);
        } catch (e) {
            return null;
        }
    }
};
`;

/**
 * 运行测试
 */
export async function runJSSymbolParserTests() {
    const parser = new JSSymbolParser();
    const output = vscode.window.createOutputChannel('JS Symbol Parser Tests');

    output.clear();
    output.show();
    output.appendLine('=== JS Symbol Parser Tests ===\n');

    // 测试 1: Vue 代码解析
    output.appendLine('Test 1: Vue Options API');
    output.appendLine('---');
    const vueResult = await parser.parse(testVueCode, vscode.Uri.parse('test://vue-test.js'));
    
    output.appendLine(`Total symbols: ${vueResult.symbols.length}`);
    output.appendLine(`Variables: ${vueResult.variables.size}`);
    output.appendLine(`Functions: ${vueResult.functions.size}`);
    output.appendLine(`Classes: ${vueResult.classes.size}`);
    output.appendLine(`This references: ${vueResult.thisReferences.size}`);
    
    output.appendLine('\nVue this.* members:');
    vueResult.thisReferences.forEach((symbol, name) => {
        output.appendLine(`  - ${name} (${symbol.kind}) at line ${symbol.range.start.line + 1}`);
    });

    // 测试 2: ES6+ 代码解析
    output.appendLine('\n\nTest 2: ES6+ Code');
    output.appendLine('---');
    const esResult = await parser.parse(testESCode, vscode.Uri.parse('test://es-test.js'));
    
    output.appendLine(`Total symbols: ${esResult.symbols.length}`);
    output.appendLine(`Variables: ${esResult.variables.size}`);
    output.appendLine(`Functions: ${esResult.functions.size}`);
    output.appendLine(`Classes: ${esResult.classes.size}`);
    
    output.appendLine('\nTop-level symbols:');
    esResult.symbols.forEach(symbol => {
        output.appendLine(`  - ${symbol.name} (${symbol.kind}) at line ${symbol.range.start.line + 1}`);
        if (symbol.children && symbol.children.length > 0) {
            symbol.children.forEach(child => {
                output.appendLine(`    └─ ${child.name} (${child.kind})`);
            });
        }
    });

    // 测试 3: 缓存机制
    output.appendLine('\n\nTest 3: Cache Performance');
    output.appendLine('---');
    const start1 = Date.now();
    await parser.parse(testVueCode, vscode.Uri.parse('test://cache-test.js'));
    const time1 = Date.now() - start1;

    const start2 = Date.now();
    await parser.parse(testVueCode, vscode.Uri.parse('test://cache-test.js'));
    const time2 = Date.now() - start2;

    output.appendLine(`First parse: ${time1}ms`);
    output.appendLine(`Cached parse: ${time2}ms`);
    output.appendLine(`Speed improvement: ${Math.round((time1 / time2) * 100) / 100}x`);

    // 测试 4: 错误恢复
    output.appendLine('\n\nTest 4: Error Recovery');
    output.appendLine('---');
    const brokenCode = `
        const data = {
            name: 'test'
            value: <?php echo $value; ?>
        };
        function test() {
            console.log({{layuiTemplate}});
        }
    `;
    
    try {
        const brokenResult = await parser.parse(brokenCode, vscode.Uri.parse('test://broken.js'));
        output.appendLine(`✓ Parsed broken code with ${brokenResult.symbols.length} symbols`);
        output.appendLine(`  Variables: ${brokenResult.variables.size}`);
        output.appendLine(`  Functions: ${brokenResult.functions.size}`);
    } catch (e) {
        output.appendLine(`✗ Failed to parse broken code: ${(e as Error).message}`);
    }

    output.appendLine('\n\n=== Tests Complete ===');
}
