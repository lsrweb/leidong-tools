import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

// 以本扩展目录作为测试工作区：工作区级功能（跨文件引用、全局符号搜索）需要 workspaceFolders
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: root,
});
