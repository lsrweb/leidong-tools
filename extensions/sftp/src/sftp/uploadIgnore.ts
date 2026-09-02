import * as path from 'path';

/** 内置忽略的目录名：VCS / IDE 元数据永远不参与上传（与主流 SFTP 插件默认 ignore 一致）。 */
const BUILTIN_IGNORED_SEGMENTS = new Set(['.git', '.svn', '.hg', '.vscode', '.idea']);

/**
 * 判断工作区相对路径是否命中上传忽略规则：
 * - 内置目录（.git/.svn/.hg/.vscode/.idea）任意层级命中即忽略；
 * - folders 中不含 "/" 的项匹配任意层级的同名文件夹；含 "/" 的项从工作区根按路径前缀匹配。
 */
export function isIgnoredUploadPath(relativePath: string, folders: string[] = []): boolean {
    const segments = relativePath.split('/');
    for (const rawFolder of folders) {
        const folder = rawFolder.trim().toLowerCase();
        if (!folder) { continue; }
        if (!folder.includes('/')) {
            if (segments.some(segment => segment.toLowerCase() === folder)) { return true; }
        } else {
            const normalized = relativePath.toLowerCase();
            if (normalized === folder || normalized.startsWith(folder + '/')) { return true; }
        }
    }
    return segments.some(segment => BUILTIN_IGNORED_SEGMENTS.has(segment.toLowerCase()));
}

/** 下载抑制 key：Windows 文件系统大小写不敏感，统一小写比较。 */
export function suppressionKey(fsPath: string): string {
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/** 目标路径是否位于抑制前缀之下（按路径段匹配，避免字符串前缀误伤兄弟目录）。 */
export function isUnderSuppressedPrefix(target: string, prefix: string): boolean {
    return target === prefix || target.startsWith(prefix + path.sep);
}
