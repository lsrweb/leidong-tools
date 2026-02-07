/**
 * 游戏模块类型定义 - 极简版
 * 
 * 设计理念：所有游戏逻辑和前端代码都在服务端
 * 扩展端只是一个「浏览器壳」，通过 WebView 加载服务器页面
 * 更新游戏只需部署服务器，无需重新发布扩展
 */

/** 游戏服务器配置 */
export interface GameServerConfig {
    /** HTTP 服务地址（提供游戏页面） */
    httpUrl: string;
    /** WebSocket 地址（游戏通信，由服务端页面自行连接） */
    wsUrl: string;
}

/** 默认服务器配置 */
export const DEFAULT_SERVER_CONFIG: GameServerConfig = {
    httpUrl: 'http://gserver.srliforever.ltd',
    wsUrl: 'ws://gserver.srliforever.ltd/ws',
};
