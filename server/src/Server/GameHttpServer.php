<?php
/**
 * HTTP 服务器
 * 提供静态页面服务和 API 接口
 */

namespace App\Server;

use Ratchet\Http\HttpServerInterface;
use Ratchet\ConnectionInterface;
use Psr\Http\Message\RequestInterface;
use App\Room\RoomManager;
use App\Logger;

class GameHttpServer implements HttpServerInterface
{
    private RoomManager $roomManager;
    private string $publicDir;
    private array $corsConfig;

    /** MIME 类型映射 */
    private static array $mimeTypes = [
        'html' => 'text/html; charset=utf-8',
        'htm'  => 'text/html; charset=utf-8',
        'css'  => 'text/css; charset=utf-8',
        'js'   => 'application/javascript; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'png'  => 'image/png',
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif'  => 'image/gif',
        'svg'  => 'image/svg+xml',
        'ico'  => 'image/x-icon',
        'woff' => 'font/woff',
        'woff2'=> 'font/woff2',
        'ttf'  => 'font/ttf',
    ];

    public function __construct(RoomManager $roomManager, array $config = [])
    {
        $this->roomManager = $roomManager;
        $this->publicDir = $config['public_dir'] ?? __DIR__ . '/../../public';
        
        // 合并 CORS 配置
        $defaultCors = [
            'allowed_origins' => ['*'],
            'allowed_methods' => ['GET', 'POST', 'OPTIONS'],
        ];
        $this->corsConfig = array_merge($defaultCors, $config['cors'] ?? []);
    }

    public function onOpen(ConnectionInterface $conn, RequestInterface $request = null): void
    {
        if ($request) {
            $this->handleRequest($conn, $request);
        }
    }

    public function onMessage(ConnectionInterface $conn, $msg): void
    {
        // HTTP 请求已在 onOpen 中处理
    }

    public function onClose(ConnectionInterface $conn): void
    {
        // noop
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        Logger::error("HTTP 错误: {$e->getMessage()}");
        $conn->close();
    }

    /**
     * 处理 HTTP 请求
     */
    public function handleRequest(ConnectionInterface $conn, RequestInterface $request): void
    {
        $uri = $request->getUri();
        $path = $uri->getPath();
        $method = $request->getMethod();
        $query = $uri->getQuery();

        Logger::debug("HTTP {$method} {$path}");

        // CORS 预检
        if ($method === 'OPTIONS') {
            $this->sendResponse($conn, 204, '', $this->getCorsHeaders());
            return;
        }

        // API 路由
        if (str_starts_with($path, '/api/')) {
            $this->handleApi($conn, $path, $method, $query);
            return;
        }

        // 静态文件服务
        $this->serveStatic($conn, $path, $query);
    }

    // ─── API 路由 ───

    private function handleApi(ConnectionInterface $conn, string $path, string $method, string $query): void
    {
        $headers = array_merge(
            $this->getCorsHeaders(),
            ['Content-Type' => 'application/json; charset=utf-8']
        );

        $response = match ($path) {
            '/api/status'      => $this->apiStatus(),
            '/api/rooms'       => $this->apiRooms($query),
            '/api/games'       => $this->apiGames(),
            '/api/player'      => $this->apiPlayer($query),
            '/api/leaderboard' => $this->apiLeaderboard($query),
            default            => ['code' => 404, 'message' => 'API not found'],
        };

        $code = $response['code'] ?? 200;
        unset($response['code']);

        $this->sendResponse($conn, $code, json_encode($response, JSON_UNESCAPED_UNICODE), $headers);
    }

    private function apiStatus(): array
    {
        $stats = $this->roomManager->getStats();
        $db = $this->roomManager->getDatabase();
        $dbStats = $db->getGlobalStats();

        return [
            'code'    => 200,
            'status'  => 'ok',
            'server'  => '雷动游戏服务器',
            'version' => '1.1.0',
            'stats'   => array_merge($stats, $dbStats),
            'uptime'  => time(),
        ];
    }

    private function apiRooms(string $query): array
    {
        parse_str($query, $params);
        $gameType = $params['gameType'] ?? '';
        $rooms = $this->roomManager->getRoomList($gameType);

        return [
            'code'  => 200,
            'rooms' => $rooms,
            'total' => count($rooms),
        ];
    }

    private function apiGames(): array
    {
        return [
            'code'  => 200,
            'games' => [
                [
                    'id'          => 'gomoku',
                    'name'        => '五子棋',
                    'description' => '经典双人对弈，五子连珠获胜',
                    'minPlayers'  => 2,
                    'maxPlayers'  => 2,
                    'icon'        => '⚫',
                ],
            ],
        ];
    }

    private function apiPlayer(string $query): array
    {
        parse_str($query, $params);
        $uid = $params['uid'] ?? '';
        if (!$uid) {
            return ['code' => 400, 'message' => '缺少 uid 参数'];
        }

        $db = $this->roomManager->getDatabase();
        $player = $db->getPlayer($uid);
        if (!$player) {
            return ['code' => 404, 'message' => '玩家不存在'];
        }

        $stats = $db->getPlayerStats($uid);
        $recentGames = $db->getRecentGames($uid, 10);

        unset($player['original_device_hash']); // 不暴露设备哈希

        return [
            'code'        => 200,
            'player'      => $player,
            'stats'       => $stats,
            'recentGames' => $recentGames,
        ];
    }

    private function apiLeaderboard(string $query): array
    {
        parse_str($query, $params);
        $limit = min((int)($params['limit'] ?? 20), 100);

        $db = $this->roomManager->getDatabase();
        $list = $db->getLeaderboard($limit);

        return [
            'code'        => 200,
            'leaderboard' => $list,
        ];
    }

    // ─── 静态文件服务 ───

    private function serveStatic(ConnectionInterface $conn, string $path, string $query): void
    {
        // 默认页面
        if ($path === '/' || $path === '') {
            $path = '/lobby.html';
        }

        // 游戏页面快捷路径
        if ($path === '/gomoku') {
            $path = '/games/gomoku.html';
        }

        // 安全检查：阻止目录遍历
        $realPublic = realpath($this->publicDir);
        $filePath = realpath($this->publicDir . $path);

        if (!$filePath || !$realPublic || !str_starts_with($filePath, $realPublic)) {
            // 尝试追加 .html
            $filePath = realpath($this->publicDir . $path . '.html');
            if (!$filePath || !str_starts_with($filePath, $realPublic)) {
                $this->serve404($conn);
                return;
            }
        }

        if (!is_file($filePath)) {
            $this->serve404($conn);
            return;
        }

        $ext = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
        $mime = self::$mimeTypes[$ext] ?? 'application/octet-stream';
        $content = file_get_contents($filePath);

        // 为 HTML 页面注入查询参数（主题等）
        if ($ext === 'html' && $query) {
            parse_str($query, $params);
            $configJson = json_encode($params, JSON_UNESCAPED_UNICODE);
            $content = str_replace(
                '</head>',
                "<script>window.__SERVER_CONFIG__ = {$configJson};</script>\n</head>",
                $content
            );
        }

        $headers = array_merge(
            $this->getCorsHeaders(),
            [
                'Content-Type'  => $mime,
                'Cache-Control' => str_contains($mime, 'text/html') ? 'no-cache' : 'public, max-age=3600',
            ]
        );

        $this->sendResponse($conn, 200, $content, $headers);
    }

    private function serve404(ConnectionInterface $conn): void
    {
        $html = '<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>';
        $this->sendResponse($conn, 404, $html, [
            'Content-Type' => 'text/html; charset=utf-8',
        ]);
    }

    // ─── 工具方法 ───

    private function sendResponse(ConnectionInterface $conn, int $status, string $body, array $headers = []): void
    {
        $statusTexts = [
            200 => 'OK', 204 => 'No Content', 304 => 'Not Modified',
            400 => 'Bad Request', 404 => 'Not Found', 500 => 'Internal Server Error',
        ];

        $statusText = $statusTexts[$status] ?? 'OK';
        $headerStr = "HTTP/1.1 {$status} {$statusText}\r\n";
        $headers['Content-Length'] = strlen($body);

        foreach ($headers as $key => $value) {
            $headerStr .= "{$key}: {$value}\r\n";
        }
        $headerStr .= "\r\n";

        $conn->send($headerStr . $body);
        $conn->close();
    }

    private function getCorsHeaders(): array
    {
        $origins = $this->corsConfig['allowed_origins'] ?? ['*'];
        $methods = $this->corsConfig['allowed_methods'] ?? ['GET', 'POST', 'OPTIONS'];
        
        return [
            'Access-Control-Allow-Origin'  => is_array($origins) ? implode(', ', $origins) : $origins,
            'Access-Control-Allow-Methods' => is_array($methods) ? implode(', ', $methods) : $methods,
            'Access-Control-Allow-Headers' => 'Content-Type, Authorization',
        ];
    }
}
