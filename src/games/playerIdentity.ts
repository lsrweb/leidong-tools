/**
 * 玩家身份管理
 * 
 * - uid: 基于系统关键信息（machineId + username + homedir）加密生成，
 *        确保同一台机器上始终是同一个玩家，即使修改昵称也不变
 * - 如果服务端检测到设备码冲突（两台机器生成了相同哈希），
 *   服务端会分配一个新 uid，客户端缓存该新 uid 以保持后续一致
 * - nickname: 用户自定义昵称，首次使用时弹窗输入，缓存在 globalState 中
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as crypto from 'crypto';

const NICKNAME_KEY = 'leidong-games.playerNickname';
const UID_OVERRIDE_KEY = 'leidong-games.uidOverride';

/** 全局 context 引用，由 activate 时注入 */
let _context: vscode.ExtensionContext | undefined;

/**
 * 初始化（必须在 activate 时调用一次）
 */
export function initPlayerIdentity(context: vscode.ExtensionContext): void {
    _context = context;
}

/**
 * 生成原始设备哈希（同一台机器始终相同）
 * 
 * 取以下系统信息拼接后做 SHA-256：
 *   - vscode.env.machineId（VS Code 为每台机器分配的唯一ID）
 *   - os.hostname()
 *   - os.userInfo().username
 *   - os.homedir()
 */
export function getDeviceHash(): string {
    const raw = [
        vscode.env.machineId,
        os.hostname(),
        os.userInfo().username,
        os.homedir(),
    ].join('|');

    return crypto
        .createHash('sha256')
        .update(raw)
        .digest('hex')
        .substring(0, 16);
}

/**
 * 获取玩家 UID
 * 
 * 优先返回服务端分配的 uid（冲突后的新uid），
 * 否则返回本地计算的设备哈希
 */
export function getPlayerUid(): string {
    const override = _context?.globalState.get<string>(UID_OVERRIDE_KEY);
    if (override) {
        return override;
    }
    return getDeviceHash();
}

/**
 * 处理服务端返回的 uid 冲突
 * 
 * 当服务端检测到两台机器生成了相同的设备码时，
 * 会为后注册的机器分配一个新 uid。
 * 客户端缓存这个新 uid，后续始终使用它。
 */
export async function handleUidConflict(newUid: string): Promise<void> {
    if (_context) {
        await _context.globalState.update(UID_OVERRIDE_KEY, newUid);
        vscode.window.showWarningMessage(
            `设备码冲突已自动处理，你的新设备ID: ${newUid.substring(0, 8)}...`
        );
    }
}

/**
 * 获取缓存的昵称（无则返回 undefined）
 */
export function getPlayerNickname(): string | undefined {
    return _context?.globalState.get<string>(NICKNAME_KEY);
}

/**
 * 保存昵称到缓存
 */
export async function setPlayerNickname(nickname: string): Promise<void> {
    if (_context) {
        await _context.globalState.update(NICKNAME_KEY, nickname);
    }
}

/**
 * 确保玩家有昵称
 * 
 * 如果缓存中没有昵称，弹出输入框让用户填写
 * 返回最终昵称；用户取消则返回 undefined
 */
export async function ensurePlayerNickname(): Promise<string | undefined> {
    let nickname = getPlayerNickname();
    if (nickname) {
        return nickname;
    }

    // 首次使用，弹窗输入
    nickname = await vscode.window.showInputBox({
        title: '🎮 设置游戏昵称',
        prompt: '给自己取一个响亮的名字吧！（之后可以在大厅右上角修改）',
        placeHolder: '例如：超级玩家、剑圣归来...',
        validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) return '昵称不能为空';
            if (trimmed.length > 20) return '昵称最多 20 个字符';
            return null;
        },
    });

    if (nickname) {
        nickname = nickname.trim();
        await setPlayerNickname(nickname);
        return nickname;
    }

    return undefined;
}

/**
 * 弹窗修改昵称
 */
export async function changePlayerNickname(): Promise<string | undefined> {
    const current = getPlayerNickname() || '';
    const nickname = await vscode.window.showInputBox({
        title: '🎮 修改游戏昵称',
        prompt: '输入新昵称',
        value: current,
        placeHolder: '新昵称...',
        validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) return '昵称不能为空';
            if (trimmed.length > 20) return '昵称最多 20 个字符';
            return null;
        },
    });

    if (nickname) {
        const trimmed = nickname.trim();
        await setPlayerNickname(trimmed);
        return trimmed;
    }
    return undefined;
}
