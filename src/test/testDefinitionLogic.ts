/**
 * @file testDefinitionLogic.ts
 * @description 测试新的定义查找逻辑
 */
import * as vscode from 'vscode';
import { DefinitionLogic } from '../finders/definitionLogic';

/**
 * 测试定义查找逻辑
 */
export async function testDefinitionLogic() {
    console.log('[Test] 开始测试定义查找逻辑...');
    
    const definitionLogic = new DefinitionLogic();
    
    // 模拟HTML文档内容
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
</head>
<body>
    <div id="app">
        <h1>{{ title }}</h1>
        <button @click="handleClick">Click me</button>
        <input v-model="userInput" />
    </div>
    
    <script>
        new Vue({
            el: '#app',
            data: {
                title: 'Hello Vue!',
                userInput: '',
                count: 0
            },
            methods: {
                handleClick() {
                    this.count++;
                    console.log('Clicked!');
                },
                updateTitle(newTitle) {
                    this.title = newTitle;
                }
            }
        });
    </script>
</body>
</html>`;

    // 创建模拟文档
    const document = await vscode.workspace.openTextDocument({
        content: htmlContent,
        language: 'html'
    });

    // 测试查找 data 中的变量
    console.log('[Test] 测试查找 data 变量...');
    
    // 模拟光标在 "title" 变量上
    const titlePosition = new vscode.Position(8, 20); // 在 {{ title }} 中的 title
    const titleLocation = await definitionLogic.provideDefinition(document, titlePosition);
    
    if (titleLocation) {
        console.log('[Test] ✅ 成功找到 title 定义:', titleLocation.uri.fsPath);
    } else {
        console.log('[Test] ❌ 未找到 title 定义');
    }

    // 测试查找 methods 中的方法
    console.log('[Test] 测试查找 methods 方法...');
    
    // 模拟光标在 "handleClick" 方法上
    const methodPosition = new vscode.Position(9, 25); // 在 @click="handleClick" 中的 handleClick
    const methodLocation = await definitionLogic.provideDefinition(document, methodPosition);
    
    if (methodLocation) {
        console.log('[Test] ✅ 成功找到 handleClick 定义:', methodLocation.uri.fsPath);
    } else {
        console.log('[Test] ❌ 未找到 handleClick 定义');
    }

    console.log('[Test] 测试完成');
}

/**
 * 测试外部 dev.js 文件查找
 */
export async function testExternalDevScript() {
    console.log('[Test] 开始测试外部 dev.js 文件查找...');
    
    const definitionLogic = new DefinitionLogic();
    
    // 模拟HTML文档内容（不包含内联脚本）
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
</head>
<body>
    <div id="app">
        <h1>{{ title }}</h1>
        <button @click="handleClick">Click me</button>
    </div>
</body>
</html>`;

    // 创建模拟文档
    const document = await vscode.workspace.openTextDocument({
        content: htmlContent,
        language: 'html'
    });

    // 测试查找（应该找不到，因为没有对应的 dev.js 文件）
    const position = new vscode.Position(7, 20);
    const location = await definitionLogic.provideDefinition(document, position);
    
    if (location) {
        console.log('[Test] ✅ 找到外部脚本定义:', location.uri.fsPath);
    } else {
        console.log('[Test] ⚠️ 未找到定义（这是预期的，因为没有 dev.js 文件）');
    }

    console.log('[Test] 外部脚本测试完成');
} 
