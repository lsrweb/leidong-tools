/**
 * 游戏管理器 - 极简版
 * 
 * 设计理念：
 *   所有游戏逻辑、WebSocket 通信、前端页面都在服务端
 *   扩展端 GameManager 只负责：
 *   1. 管理服务器地址配置
 *   2. 检测服务器状态
 *   3. 打开/关闭游戏面板
 *   
 *   NO WebSocket, NO 房间管理, NO 游戏状态 —— 全在服务端
 */
import * as vscode from 'vscode';
import { DEFAULT_SERVER_CONFIG, GameServerConfig } from './gameTypes';

export class GameManager {
    private static _instance: GameManager;
    private _config: GameServerConfig;

    private constructor() {
        const vsConfig = vscode.workspace.getConfiguration('leidong-tools');
        this._config = {
            httpUrl: vsConfig.get<string>('gameServerUrl', DEFAULT_SERVER_CONFIG.httpUrl),
            wsUrl: vsConfig.get<string>('gameServerWsUrl', DEFAULT_SERVER_CONFIG.wsUrl),
        };
    }

    static getInstance(): GameManager {
        if (!GameManager._instance) {
            GameManager._instance = new GameManager();
        }
        return GameManager._instance;
    }

    get config(): GameServerConfig {
        return this._config;
    }

    get httpUrl(): string {
        return this._config.httpUrl;
    }

    /** 更新服务器地址 */
    setServerUrl(httpUrl: string): void {
        this._config.httpUrl = httpUrl.replace(/\/+$/, '');
    }

    /** 检测服务器是否在线 */
    async checkServer(url?: string): Promise<boolean> {
        const target = url || this._config.httpUrl;
        try {
            const http = require('http');
            return new Promise<boolean>((resolve) => {
                const req = http.get(`${target}/api/status`, (res: any) => {
                    resolve(res.statusCode === 200);
                });
                req.on('error', () => resolve(false));
                req.setTimeout(3000, () => { req.destroy(); resolve(false); });
            });
        } catch {
            return false;
        }
    }

    dispose(): void {
        // 极简版无需清理资源
    }
}

