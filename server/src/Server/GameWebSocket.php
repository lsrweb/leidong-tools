<?php
/**
 * WebSocket 游戏服务器
 * 处理实时通信：房间管理、游戏操作、心跳
 */

namespace App\Server;

use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;
use App\Room\RoomManager;
use App\Games\Gomoku;
use App\Logger;

class GameWebSocket implements MessageComponentInterface
{
    private RoomManager $roomManager;

    /** @var array<string, Gomoku> roomId => Gomoku 实例 */
    private array $games = [];

    private int $heartbeatInterval;
    private int $heartbeatTimeout;

    public function __construct(RoomManager $roomManager, array $config = [])
    {
        $this->roomManager = $roomManager;
        $this->heartbeatInterval = $config['heartbeat_interval'] ?? 30;
        $this->heartbeatTimeout = $config['heartbeat_timeout'] ?? 90;
    }

    public function onOpen(ConnectionInterface $conn): void
    {
        $conn->lastPong = time();
        Logger::info("WebSocket 连接打开: conn={$conn->resourceId}");
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        $data = json_decode($msg, true);
        if (!$data || !isset($data['type'])) {
            $this->send($from, ['type' => 'error', 'message' => '无效消息格式']);
            return;
        }

        $from->lastPong = time();

        try {
            match ($data['type']) {
                'register'      => $this->handleRegister($from, $data),
                'createRoom'    => $this->handleCreateRoom($from, $data),
                'joinRoom'      => $this->handleJoinRoom($from, $data),
                'spectateRoom'  => $this->handleSpectateRoom($from, $data),
                'leaveRoom'     => $this->handleLeaveRoom($from),
                'roomList'      => $this->handleRoomList($from, $data),
                'gameMove'      => $this->handleGameMove($from, $data),
                'gameRestart'   => $this->handleGameRestart($from),
                'chat'          => $this->handleChat($from, $data),
                'pong'          => $this->handlePong($from),
                default         => $this->send($from, ['type' => 'error', 'message' => "未知消息类型: {$data['type']}"]),
            };
        } catch (\Throwable $e) {
            Logger::error("消息处理异常: {$e->getMessage()}");
            $this->send($from, ['type' => 'error', 'message' => '服务器内部错误']);
        }
    }

    public function onClose(ConnectionInterface $conn): void
    {
        $connId = $conn->resourceId;
        $roomId = $this->roomManager->getPlayerRoomId($connId);
        $player = $this->roomManager->getPlayer($connId);
        $playerName = $player['name'] ?? 'unknown';

        // 通知房间其他玩家（含观战者）
        if ($roomId) {
            $allConns = $this->roomManager->getAllRoomConnections($roomId);
            $others = array_filter($allConns, fn($c) => $c->resourceId !== $connId);
            foreach ($others as $other) {
                $this->send($other, [
                    'type'       => 'playerLeft',
                    'playerName' => $playerName,
                    'roomId'     => $roomId,
                    'isPlayer'   => !$this->roomManager->isSpectator($roomId, $connId),
                ]);
            }

            // 如果游戏进行中且是玩家离开，通知所有人房间关闭
            if (isset($this->games[$roomId]) && !$this->games[$roomId]->isFinished()
                && !$this->roomManager->isSpectator($roomId, $connId)) {
                $room = $this->roomManager->getRoom($roomId);
                if ($room && $room['status'] === 'playing') {
                    foreach ($others as $other) {
                        $this->send($other, [
                            'type'       => 'gameOver',
                            'reason'     => 'opponent_disconnected',
                            'message'    => "{$playerName} 断开连接",
                            'roomClosed' => true,
                        ]);
                    }
                    $this->roomManager->updateRoomStatus($roomId, 'waiting');
                    unset($this->games[$roomId]);
                }
            }
        }

        $this->roomManager->removePlayer($conn);
        Logger::info("WebSocket 连接关闭: conn={$connId} ({$playerName})");
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        Logger::error("WebSocket 错误: conn={$conn->resourceId}, {$e->getMessage()}");
        $conn->close();
    }

    // ─── 心跳 ───

    /**
     * 由定时器调用，发送 ping 并清理超时连接
     */
    public function checkHeartbeats(\SplObjectStorage $connections): void
    {
        $now = time();
        foreach ($connections as $conn) {
            if (($now - ($conn->lastPong ?? $now)) > $this->heartbeatTimeout) {
                Logger::warn("心跳超时，关闭连接: conn={$conn->resourceId}");
                $conn->close();
            } else {
                $this->send($conn, ['type' => 'ping']);
            }
        }
    }

    private function handlePong(ConnectionInterface $conn): void
    {
        $conn->lastPong = time();
    }

    // ─── 注册 ───

    private function handleRegister(ConnectionInterface $conn, array $data): void
    {
        $name = trim($data['playerName'] ?? '');
        $uid = trim($data['uid'] ?? '');
        $deviceHash = trim($data['deviceHash'] ?? '');
        if (!$name) {
            $name = '玩家' . $conn->resourceId;
        }

        $player = $this->roomManager->registerPlayer($conn, $name, $uid, $deviceHash);

        $response = [
            'type'       => 'registered',
            'playerName' => $player['name'],
            'uid'        => $player['uid'],
            'connId'     => $player['connId'],
        ];

        // 通知客户端 uid 冲突，客户端需缓存新 uid
        if (!empty($player['uidConflict'])) {
            $response['uidConflict'] = true;
            $response['originalUid'] = $player['originalUid'];
            $response['newUid'] = $player['uid'];
        }

        // 获取玩家战绩
        if ($player['uid']) {
            $db = $this->roomManager->getDatabase();
            $response['stats'] = $db->getPlayerStats($player['uid']);
        }

        $this->send($conn, $response);
    }

    // ─── 房间操作 ───

    private function handleCreateRoom(ConnectionInterface $conn, array $data): void
    {
        $gameType = $data['gameType'] ?? 'gomoku';
        $roomName = $data['roomName'] ?? '';

        $room = $this->roomManager->createRoom($conn, $gameType, $roomName);
        if (!$room) {
            $this->send($conn, ['type' => 'error', 'message' => '创建房间失败（请先注册或房间已满）']);
            return;
        }

        $this->send($conn, [
            'type' => 'roomCreated',
            'room' => $this->formatRoom($room),
        ]);
    }

    private function handleJoinRoom(ConnectionInterface $conn, array $data): void
    {
        $roomId = $data['roomId'] ?? '';
        if (!$roomId) {
            $this->send($conn, ['type' => 'error', 'message' => '缺少房间ID']);
            return;
        }

        $room = $this->roomManager->joinRoom($conn, $roomId);
        if (!$room) {
            $this->send($conn, ['type' => 'error', 'message' => '加入房间失败（房间不存在、已满或已开始）']);
            return;
        }

        $player = $this->roomManager->getPlayer($conn->resourceId);

        // 通知加入者
        $this->send($conn, [
            'type' => 'roomJoined',
            'room' => $this->formatRoom($room),
        ]);

        // 通知房间所有其他人（含观战者）
        $allConns = $this->roomManager->getAllRoomConnections($roomId);
        $others = array_filter($allConns, fn($c) => $c->resourceId !== $conn->resourceId);
        foreach ($others as $other) {
            $this->send($other, [
                'type'       => 'playerJoined',
                'playerName' => $player['name'],
                'room'       => $this->formatRoom($room),
            ]);
        }

        // 如果人满了，自动开始游戏
        if (count($room['players']) >= 2) {
            $this->startGame($roomId);
        }
    }

    private function handleLeaveRoom(ConnectionInterface $conn): void
    {
        $connId = $conn->resourceId;
        $roomId = $this->roomManager->getPlayerRoomId($connId);

        if (!$roomId) {
            $this->send($conn, ['type' => 'error', 'message' => '你不在任何房间中']);
            return;
        }

        // 先获取所有连接（含观战者）
        $allConns = $this->roomManager->getAllRoomConnections($roomId);
        $others = array_filter($allConns, fn($c) => $c->resourceId !== $connId);
        $player = $this->roomManager->getPlayer($connId);
        $isSpectator = $this->roomManager->isSpectator($roomId, $connId);

        $room = $this->roomManager->leaveRoom($conn);

        $this->send($conn, ['type' => 'roomLeft']);

        // 如果是玩家离开，清理游戏并通知房间关闭
        if (!$isSpectator && isset($this->games[$roomId])) {
            foreach ($others as $other) {
                $this->send($other, [
                    'type'       => 'gameOver',
                    'reason'     => 'opponent_left',
                    'message'    => "{$player['name']} 离开了房间",
                    'roomClosed' => true,
                ]);
            }
            unset($this->games[$roomId]);
        }

        // 通知其他人
        foreach ($others as $other) {
            $this->send($other, [
                'type'       => 'playerLeft',
                'playerName' => $player['name'],
                'isPlayer'   => !$isSpectator,
                'room'       => $room ? $this->formatRoom($room) : null,
            ]);
        }
    }

    private function handleSpectateRoom(ConnectionInterface $conn, array $data): void
    {
        $roomId = $data['roomId'] ?? '';
        if (!$roomId) {
            $this->send($conn, ['type' => 'error', 'message' => '缺少房间ID']);
            return;
        }

        $room = $this->roomManager->joinAsSpectator($conn, $roomId);
        if (!$room) {
            $this->send($conn, ['type' => 'error', 'message' => '加入观战失败（房间不存在）']);
            return;
        }

        $player = $this->roomManager->getPlayer($conn->resourceId);
        $game = $this->games[$roomId] ?? null;

        // 告诉观战者当前状态
        $this->send($conn, [
            'type'       => 'spectateJoined',
            'room'       => $this->formatRoom($room),
            'gameState'  => $game ? $game->getState() : null,
            'isPlaying'  => $room['status'] === 'playing',
        ]);

        // 通知房间所有人
        $allConns = $this->roomManager->getAllRoomConnections($roomId);
        $others = array_filter($allConns, fn($c) => $c->resourceId !== $conn->resourceId);
        foreach ($others as $other) {
            $this->send($other, [
                'type'          => 'spectatorJoined',
                'playerName'    => $player['name'],
                'spectatorCount' => count($room['spectators'] ?? []),
            ]);
        }
    }

    private function handleRoomList(ConnectionInterface $conn, array $data): void
    {
        $gameType = $data['gameType'] ?? '';
        $list = $this->roomManager->getRoomList($gameType);
        $stats = $this->roomManager->getStats();

        $this->send($conn, [
            'type'  => 'roomList',
            'rooms' => $list,
            'stats' => $stats,
        ]);
    }

    // ─── 游戏操作 ───

    private function startGame(string $roomId): void
    {
        $room = $this->roomManager->getRoom($roomId);
        if (!$room || count($room['players']) < 2) return;

        $game = new Gomoku();
        $game->assignPlayers($room['players']);
        $this->games[$roomId] = $game;
        $this->roomManager->updateRoomStatus($roomId, 'playing');

        $state = $game->getState();

        // 通知每个玩家他的颜色和游戏状态
        foreach ($room['players'] as $connId) {
            $player = $this->roomManager->getPlayer($connId);
            if (!$player) continue;

            $this->send($player['conn'], [
                'type'      => 'gameStart',
                'gameType'  => $room['gameType'],
                'roomId'    => $roomId,
                'yourColor' => $game->getPlayerColorName($connId),
                'state'     => $state,
            ]);
        }

        // 通知观战者游戏开始
        foreach (($room['spectators'] ?? []) as $specConnId) {
            $specPlayer = $this->roomManager->getPlayer($specConnId);
            if (!$specPlayer) continue;
            $this->send($specPlayer['conn'], [
                'type'      => 'gameStart',
                'gameType'  => $room['gameType'],
                'roomId'    => $roomId,
                'yourColor' => 'spectator',
                'state'     => $state,
            ]);
        }

        Logger::info("游戏开始: room={$roomId}, type={$room['gameType']}");
    }

    private function handleGameMove(ConnectionInterface $from, array $data): void
    {
        $connId = $from->resourceId;
        $roomId = $this->roomManager->getPlayerRoomId($connId);

        if (!$roomId || !isset($this->games[$roomId])) {
            $this->send($from, ['type' => 'error', 'message' => '当前没有进行中的游戏']);
            return;
        }

        $game = $this->games[$roomId];
        $row = (int)($data['row'] ?? -1);
        $col = (int)($data['col'] ?? -1);

        $result = $game->makeMove($connId, $row, $col);

        if (!$result['success']) {
            $this->send($from, ['type' => 'moveRejected', 'error' => $result['error']]);
            return;
        }

        // 广播落子结果给房间所有人（含观战者）
        $connections = $this->roomManager->getAllRoomConnections($roomId);
        $moveData = [
            'type'  => 'gameMove',
            'row'   => $result['row'],
            'col'   => $result['col'],
            'color' => $result['color'],
            'state' => $game->getState(),
        ];

        if ($result['winner']) {
            $moveData['winner'] = $result['winner'];
            $moveData['winLine'] = $result['winLine'];
            $this->roomManager->updateRoomStatus($roomId, 'finished');
            $this->saveGameRecord($roomId, $result['winner'], false);
        }
        if ($result['isDraw']) {
            $moveData['isDraw'] = true;
            $this->roomManager->updateRoomStatus($roomId, 'finished');
            $this->saveGameRecord($roomId, null, true);
        }

        foreach ($connections as $conn) {
            $this->send($conn, $moveData);
        }
    }

    private function handleGameRestart(ConnectionInterface $from): void
    {
        $connId = $from->resourceId;
        $roomId = $this->roomManager->getPlayerRoomId($connId);

        if (!$roomId) {
            $this->send($from, ['type' => 'error', 'message' => '你不在任何房间中']);
            return;
        }

        $room = $this->roomManager->getRoom($roomId);
        if (!$room || count($room['players']) < 2) {
            $this->send($from, ['type' => 'error', 'message' => '需要两名玩家才能重新开始']);
            return;
        }

        // 重新开始游戏
        $this->startGame($roomId);
    }

    // ─── 聊天 ───

    private function handleChat(ConnectionInterface $from, array $data): void
    {
        $connId = $from->resourceId;
        $roomId = $this->roomManager->getPlayerRoomId($connId);
        $player = $this->roomManager->getPlayer($connId);

        if (!$roomId || !$player) return;

        $message = trim($data['message'] ?? '');
        if (!$message) return;

        // 限制长度
        $message = mb_substr($message, 0, 200);

        // 广播给房间所有人（含观战者）
        $allConns = $this->roomManager->getAllRoomConnections($roomId);
        $isSpectator = $this->roomManager->isSpectator($roomId, $connId);
        foreach ($allConns as $conn) {
            $this->send($conn, [
                'type'       => 'chat',
                'playerName' => $player['name'],
                'message'    => $message,
                'time'       => date('H:i:s'),
                'role'       => $isSpectator ? 'spectator' : 'player',
            ]);
        }
    }

    // ─── 游戏记录 ───

    /**
     * 保存游戏记录到数据库
     */
    private function saveGameRecord(string $roomId, ?string $winnerConnId, bool $isDraw): void
    {
        try {
            $room = $this->roomManager->getRoom($roomId);
            if (!$room || count($room['players']) < 2) return;

            $game = $this->games[$roomId] ?? null;

            $p1 = $this->roomManager->getPlayer($room['players'][0]);
            $p2 = $this->roomManager->getPlayer($room['players'][1]);
            if (!$p1 || !$p2) return;

            $winnerUid = null;
            if ($winnerConnId && !$isDraw) {
                $winner = $this->roomManager->getPlayer((int)$winnerConnId);
                $winnerUid = $winner['uid'] ?? null;
            }

            $db = $this->roomManager->getDatabase();
            $db->saveGameRecord([
                'room_id'          => $roomId,
                'game_type'        => $room['gameType'],
                'player1_uid'      => $p1['uid'] ?? '',
                'player2_uid'      => $p2['uid'] ?? '',
                'winner_uid'       => $winnerUid,
                'is_draw'          => $isDraw,
                'moves_count'      => $game ? $game->getMoveCount() : 0,
                'duration_seconds'  => time() - ($room['createdAt'] ?? time()),
                'finished_at'      => time(),
            ]);

            Logger::info("游戏记录已保存: room={$roomId}");
        } catch (\Throwable $e) {
            Logger::error("保存游戏记录失败: {$e->getMessage()}");
        }
    }

    // ─── 工具方法 ───

    private function send(ConnectionInterface $conn, array $data): void
    {
        try {
            $conn->send(json_encode($data, JSON_UNESCAPED_UNICODE));
        } catch (\Throwable $e) {
            Logger::error("发送消息失败: conn={$conn->resourceId}, {$e->getMessage()}");
        }
    }

    private function formatRoom(array $room): array
    {
        $playerInfos = [];
        foreach ($room['players'] as $connId) {
            $player = $this->roomManager->getPlayer($connId);
            if ($player) {
                $playerInfos[] = [
                    'name' => $player['name'],
                    'uid'  => $player['uid'] ?? '',
                ];
            }
        }

        $spectatorInfos = [];
        foreach (($room['spectators'] ?? []) as $specConnId) {
            $spec = $this->roomManager->getPlayer($specConnId);
            if ($spec) {
                $spectatorInfos[] = ['name' => $spec['name']];
            }
        }

        return [
            'id'             => $room['id'],
            'name'           => $room['name'],
            'gameType'       => $room['gameType'],
            'status'         => $room['status'],
            'playerCount'    => count($room['players']),
            'maxPlayers'     => 2,
            'players'        => $playerInfos,
            'spectatorCount' => count($spectatorInfos),
            'spectators'     => $spectatorInfos,
        ];
    }
}
