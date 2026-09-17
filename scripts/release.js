#!/usr/bin/env node
/**
 * 发布流程：测试通过 → 构建打包 vsix → 发布到 VS Code Marketplace。
 * 测试失败即中止（与本仓库"测试通过才允许发布"的门禁一致）。
 * 用法：npm run release（在扩展目录下执行；版本号取自 package.json，发布前先递增版本与更新 CHANGELOG）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 名称/版本来自本仓库 package.json，先做格式校验再参与命令行与文件名拼接
if (!/^[a-z0-9][a-z0-9-]*$/.test(pkg.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    console.error(`✘ package.json 的 name/version 格式异常：${pkg.name}@${pkg.version}`);
    process.exit(1);
}
const vsixName = `${pkg.name}-${pkg.version}.vsix`;

/** 以参数数组方式执行命令（Windows 下 npm/npx 是 .cmd，需要 shell 承接） */
const run = (command, args) => {
    console.log(`\n> ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) {
        throw new Error(`${command} 执行失败（退出码 ${result.status}）`);
    }
};

try {
    console.log(`发布 ${pkg.name} v${pkg.version}`);
    run('npm', ['test']);                                    // 测试门禁：失败直接中止
    run('npm', ['run', 'vsix']);                             // 打包（内含 webpack production 构建）
    const vsixPath = path.join(root, vsixName);
    if (!fs.existsSync(vsixPath)) {
        throw new Error(`未找到打包产物 ${vsixName}`);
    }
    run('npx', ['vsce', 'publish', '--packagePath', vsixName]);
    console.log(`\n✔ 发布完成：${pkg.name} v${pkg.version}（${vsixName}）`);
} catch (error) {
    console.error(`\n✘ 发布中止：${(error && error.message) || error}`);
    process.exit(1);
}
