<?php
/**
 * 游戏服务器启动入口
 * 
 * 同时启动：
 *   - HTTP 服务器 (端口 8088) - 提供游戏页面和 API
 *   - WebSocket 服务器 (端口 8089) - 实时游戏通信
 * 
 * 用法: php start.php [--dev]
 */

require __DIR__ . '/vendor/autoload.php';

// 屏蔽过时警告（Ratchet 组件内部使用了大量 PHP 8.2+ 弃用的动态属性）
error_reporting(E_ALL & ~E_DEPRECATED);

use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;
use React\EventLoop\Loop;
use React\Socket\SocketServer;

use App\Server\GameWebSocket;
use App\Server\GameHttpServer;
use App\Room\RoomManager;
use App\Database\Database;
use App\Logger;

// 加载配置
$config = require __DIR__ . '/config/config.php';
$isDev = ($config['env'] ?? 'production') === 'dev';

// 日志级别已在 config.php 中根据环境自动设置

// 初始化日志
Logger::init($config['log']);

Logger::info("========================================");
Logger::info("  🎮 雷动三千小游戏服务器");
Logger::info("  环境: " . ($isDev ? '开发模式' : '生产模式'));
Logger::info("========================================");

// 创建事件循环
$loop = Loop::get();

// 初始化 SQLite 数据库
$dbPath = $config['database']['path'] ?? __DIR__ . '/data/game.db';
$db = Database::getInstance($dbPath);

// 创建房间管理器（全局共享）
$roomManager = new RoomManager($db, $config['room']);

// =================== WebSocket 服务器 ===================
$wsApp = new GameWebSocket($roomManager, $config);
$wsServer = new WsServer($wsApp);
$wsServer->enableKeepAlive($loop, $config['heartbeat']['interval']);

$wsSocket = new SocketServer(
    $config['bind_address'] . ':' . $config['ws_port'],
    [],
    $loop
);

$wsIoServer = new IoServer(
    new HttpServer($wsServer),
    $wsSocket,
    $loop
);

Logger::info("🔌 WebSocket 服务已启动: ws://{$config['bind_address']}:{$config['ws_port']}");

// =================== HTTP 服务器 ===================
$httpApp = new GameHttpServer($roomManager, $config);

$httpSocket = new SocketServer(
    $config['bind_address'] . ':' . $config['http_port'],
    [],
    $loop
);

$httpIoServer = new IoServer(
    new HttpServer($httpApp),
    $httpSocket,
    $loop
);

Logger::info("🌐 HTTP 服务已启动:  http://{$config['bind_address']}:{$config['http_port']}");

// =================== 定时任务 ===================
// 房间清理
$loop->addPeriodicTimer($config['room']['cleanup_interval'], function () use ($roomManager, $config) {
    $cleaned = $roomManager->cleanupIdleRooms($config['room']['max_idle_time'] ?? 1800);
    if ($cleaned > 0) {
        Logger::info("🧹 已清理 {$cleaned} 个过期房间");
    }
});

Logger::info("----------------------------------------");
Logger::info("📡 服务器已就绪，等待连接...");
if ($isDev) {
    Logger::info("   VS Code 扩展配置: http://{$config['bind_address']}:{$config['http_port']}");
} else {
    Logger::info("   生产域名: http://{$config['domain']}");
    Logger::info("   NGINX 反代: 127.0.0.1:{$config['http_port']} (HTTP) + 127.0.0.1:{$config['ws_port']} (WS)");
}
Logger::info("----------------------------------------");

// 启动事件循环
$loop->run();
