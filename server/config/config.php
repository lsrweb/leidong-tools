<?php
/**
 * 游戏服务器配置
 */

$isDev = in_array('--dev', $GLOBALS['argv'] ?? $_SERVER['argv'] ?? []);

return [
    // 环境模式
    'env' => $isDev ? 'dev' : 'production',

    // 生产环境域名
    'domain' => 'gserver.srliforever.ltd',

    // 部署路径（宝塔面板默认）
    'deploy_path' => '/www/wwwroot/gserver/leidong-tools',

    // HTTP 服务端口（Ratchet 内置 HTTP，生产环境由 NGINX 反代 /api/*）
    'http_port' => 8088,

    // WebSocket 服务端口（生产环境由 NGINX 反代 /ws 路径）
    'ws_port' => 8089,

    // 绑定地址（生产环境绑 127.0.0.1，开发环境绑 0.0.0.0）
    'bind_address' => $isDev ? '0.0.0.0' : '127.0.0.1',

    // 静态文件目录
    'public_dir' => __DIR__ . '/../public',

    // 房间配置
    'room' => [
        'max_idle_time' => 1800,     // 房间空闲最大时间（秒）
        'cleanup_interval' => 60,    // 清理间隔（秒）
    ],

    // 心跳配置
    'heartbeat' => [
        'interval' => 30,            // 心跳间隔（秒）
        'timeout' => 90,             // 超时断开（秒）
    ],

    // 日志
    'log' => [
        'enabled' => true,
        'level' => $isDev ? 'debug' : 'info',
    ],

    // CORS（跨域）
    'cors' => [
        'allowed_origins' => $isDev ? ['*'] : ['http://gserver.srliforever.ltd', 'https://gserver.srliforever.ltd'],
    ],

    // 数据库
    'database' => [
        'path' => __DIR__ . '/../data/game.db',
    ],
];
