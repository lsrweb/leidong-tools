<?php
/**
 * 游戏服务器配置
 */
return [
    // HTTP 服务端口（提供游戏页面）
    'http_port' => 8088,

    // WebSocket 服务端口（游戏通信）
    'ws_port' => 8089,

    // 绑定地址（0.0.0.0 允许外部访问）
    'bind_address' => '0.0.0.0',

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
        'level' => 'info',           // debug | info | warn | error
    ],

    // CORS（跨域）
    'cors' => [
        'allowed_origins' => ['*'],  // 生产环境请限制
    ],

    // 数据库
    'database' => [
        'path' => __DIR__ . '/../data/game.db',
    ],
];
