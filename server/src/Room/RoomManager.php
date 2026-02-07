<?php
/**
 * 房间管理器 - 管理游戏房间的创建、加入、离开、清理
 */

namespace App\Room;

use App\Logger;
use App\Database\Database;
use Ratchet\ConnectionInterface;

class RoomManager
{
    /** @var array<string, array> 房间列表 roomId => roomData */
    private array $rooms = [];

    /** @var array<int, string> 连接ID到房间ID的映射 */
    private array $connectionRooms = [];

    /** @var array<int, array> 连接ID到玩家信息的映射 */
    private array $players = [];

    /** @var array<string, int> uid到连接ID的映射，用于重连识别 */
    private array $uidMap = [];

    private Database $db;
    private int $maxPlayersPerRoom;
    private int $maxRooms;

    public function __construct(Database $db, array $config = [])
    {
        $this->db = $db;
        $this->maxPlayersPerRoom = $config['max_players_per_room'] ?? 2;
        $this->maxRooms = $config['max_rooms'] ?? 50;
    }

    /**
     * 注册玩家连接
     * 
     * @param string $uid 客户端生成的设备码
     * @param string $deviceHash 原始设备哈希（用于冲突检测）
     * @return array 玩家信息（uid 可能因冲突而改变）
     */
    public function registerPlayer(ConnectionInterface $conn, string $playerName, string $uid = '', string $deviceHash = ''): array
    {
        $connId = $conn->resourceId;
        $finalUid = $uid;
        $uidConflict = false;

        if ($uid) {
            // 通过数据库检测 uid 冲突
            $resolution = $this->db->resolveUidConflict($uid, $deviceHash ?: $uid);
            if ($resolution['conflict']) {
                $finalUid = $resolution['uid'];
                $uidConflict = true;
                Logger::warn("设备码冲突: 原始={$uid}, 新分配={$finalUid}");
            }

            // 持久化到数据库
            $this->db->registerPlayer($finalUid, $playerName, $deviceHash ?: $uid);
        }

        $this->players[$connId] = [
            'conn'       => $conn,
            'name'       => $playerName,
            'uid'        => $finalUid,
            'connId'     => $connId,
            'joinedAt'   => time(),
            'uidConflict' => $uidConflict,
            'originalUid' => $uid,
        ];
        if ($finalUid) {
            $this->uidMap[$finalUid] = $connId;
        }
        Logger::info("玩家注册: {$playerName} (conn={$connId}, uid={$finalUid})");
        return $this->players[$connId];
    }

    /**
     * 获取数据库实例（供外部访问）
     */
    public function getDatabase(): Database
    {
        return $this->db;
    }

    /**
     * 获取玩家信息
     */
    public function getPlayer(int $connId): ?array
    {
        return $this->players[$connId] ?? null;
    }

    /**
     * 创建房间
     */
    public function createRoom(ConnectionInterface $conn, string $gameType, string $roomName = ''): ?array
    {
        $connId = $conn->resourceId;
        $player = $this->getPlayer($connId);
        if (!$player) return null;

        if (count($this->rooms) >= $this->maxRooms) {
            Logger::warn("房间数已满: {$this->maxRooms}");
            return null;
        }

        // 如果玩家已在某个房间，先离开
        if (isset($this->connectionRooms[$connId])) {
            $this->leaveRoom($conn);
        }

        $roomId = $this->generateRoomId();
        $room = [
            'id'        => $roomId,
            'name'      => $roomName ?: ($player['name'] . '的房间'),
            'gameType'  => $gameType,
            'hostId'    => $connId,
            'players'   => [$connId],
            'spectators' => [],
            'status'    => 'waiting',     // waiting | playing | finished
            'gameState' => null,
            'createdAt' => time(),
            'updatedAt' => time(),
        ];

        $this->rooms[$roomId] = $room;
        $this->connectionRooms[$connId] = $roomId;

        Logger::info("房间创建: {$roomId} ({$gameType}) by {$player['name']}");
        return $room;
    }

    /**
     * 加入房间
     */
    public function joinRoom(ConnectionInterface $conn, string $roomId): ?array
    {
        $connId = $conn->resourceId;
        $player = $this->getPlayer($connId);
        if (!$player) return null;

        $room = $this->rooms[$roomId] ?? null;
        if (!$room) return null;

        if ($room['status'] !== 'waiting') {
            Logger::warn("房间 {$roomId} 不在等待状态");
            return null;
        }

        if (count($room['players']) >= $this->maxPlayersPerRoom) {
            Logger::warn("房间 {$roomId} 已满");
            return null;
        }

        // 如果已在其他房间，先离开
        if (isset($this->connectionRooms[$connId])) {
            $this->leaveRoom($conn);
        }

        $this->rooms[$roomId]['players'][] = $connId;
        $this->rooms[$roomId]['updatedAt'] = time();
        $this->connectionRooms[$connId] = $roomId;

        Logger::info("玩家 {$player['name']} 加入房间 {$roomId}");
        return $this->rooms[$roomId];
    }

    /**
     * 以观战者身份加入房间
     */
    public function joinAsSpectator(ConnectionInterface $conn, string $roomId): ?array
    {
        $connId = $conn->resourceId;
        $player = $this->getPlayer($connId);
        if (!$player) return null;

        $room = $this->rooms[$roomId] ?? null;
        if (!$room) return null;

        // 如果已在其他房间，先离开
        if (isset($this->connectionRooms[$connId])) {
            $this->leaveRoom($conn);
        }

        $this->rooms[$roomId]['spectators'][] = $connId;
        $this->rooms[$roomId]['updatedAt'] = time();
        $this->connectionRooms[$connId] = $roomId;

        Logger::info("观战者 {$player['name']} 加入房间 {$roomId}");
        return $this->rooms[$roomId];
    }

    /**
     * 检查连接是否是观战者
     */
    public function isSpectator(string $roomId, int $connId): bool
    {
        $room = $this->rooms[$roomId] ?? null;
        if (!$room) return false;
        return in_array($connId, $room['spectators'] ?? []);
    }

    /**
     * 离开房间
     */
    public function leaveRoom(ConnectionInterface $conn): ?array
    {
        $connId = $conn->resourceId;
        $roomId = $this->connectionRooms[$connId] ?? null;
        if (!$roomId || !isset($this->rooms[$roomId])) {
            unset($this->connectionRooms[$connId]);
            return null;
        }

        $room = &$this->rooms[$roomId];
        // 从玩家列表或观战列表移除
        $room['players'] = array_values(array_filter($room['players'], fn($id) => $id !== $connId));
        $room['spectators'] = array_values(array_filter($room['spectators'] ?? [], fn($id) => $id !== $connId));
        $room['updatedAt'] = time();
        unset($this->connectionRooms[$connId]);

        $player = $this->getPlayer($connId);
        $playerName = $player['name'] ?? "conn={$connId}";
        Logger::info("玩家 {$playerName} 离开房间 {$roomId}");

        // 如果房间空了（玩家+观战者都没了），删除
        if (empty($room['players']) && empty($room['spectators'])) {
            Logger::info("房间 {$roomId} 已空，删除");
            $removedRoom = $room;
            unset($this->rooms[$roomId]);
            return $removedRoom;
        }

        // 如果房主离开，转移房主
        if ($room['hostId'] === $connId) {
            $room['hostId'] = $room['players'][0];
            $newHost = $this->getPlayer($room['players'][0]);
            Logger::info("房主转移至 {$newHost['name']}");
        }

        return $room;
    }

    /**
     * 玩家断开连接
     */
    public function removePlayer(ConnectionInterface $conn): void
    {
        $connId = $conn->resourceId;
        $this->leaveRoom($conn);
        // 清理 uid 映射
        $player = $this->players[$connId] ?? null;
        if ($player && !empty($player['uid'])) {
            unset($this->uidMap[$player['uid']]);
        }
        unset($this->players[$connId]);
    }

    /**
     * 获取房间信息
     */
    public function getRoom(string $roomId): ?array
    {
        return $this->rooms[$roomId] ?? null;
    }

    /**
     * 获取玩家所在的房间ID
     */
    public function getPlayerRoomId(int $connId): ?string
    {
        return $this->connectionRooms[$connId] ?? null;
    }

    /**
     * 获取房间内所有玩家的连接
     * @return ConnectionInterface[]
     */
    public function getRoomConnections(string $roomId): array
    {
        $room = $this->rooms[$roomId] ?? null;
        if (!$room) return [];

        $connections = [];
        foreach ($room['players'] as $connId) {
            $player = $this->getPlayer($connId);
            if ($player && $player['conn']) {
                $connections[] = $player['conn'];
            }
        }
        return $connections;
    }

    /**
     * 获取房间内所有连接（玩家+观战者）
     * @return ConnectionInterface[]
     */
    public function getAllRoomConnections(string $roomId): array
    {
        $room = $this->rooms[$roomId] ?? null;
        if (!$room) return [];

        $connections = [];
        $allIds = array_merge($room['players'], $room['spectators'] ?? []);
        foreach ($allIds as $connId) {
            $player = $this->getPlayer($connId);
            if ($player && $player['conn']) {
                $connections[] = $player['conn'];
            }
        }
        return $connections;
    }

    /**
     * 获取房间内其他玩家的连接（排除指定连接）
     * @return ConnectionInterface[]
     */
    public function getOtherConnections(string $roomId, int $excludeConnId): array
    {
        return array_filter(
            $this->getRoomConnections($roomId),
            fn($conn) => $conn->resourceId !== $excludeConnId
        );
    }

    /**
     * 更新房间状态
     */
    public function updateRoomStatus(string $roomId, string $status): void
    {
        if (isset($this->rooms[$roomId])) {
            $this->rooms[$roomId]['status'] = $status;
            $this->rooms[$roomId]['updatedAt'] = time();
        }
    }

    /**
     * 更新房间游戏状态
     */
    public function updateGameState(string $roomId, $gameState): void
    {
        if (isset($this->rooms[$roomId])) {
            $this->rooms[$roomId]['gameState'] = $gameState;
            $this->rooms[$roomId]['updatedAt'] = time();
        }
    }

    /**
     * 获取房间列表（用于大厅展示）
     */
    public function getRoomList(string $gameType = ''): array
    {
        $list = [];
        foreach ($this->rooms as $room) {
            if ($gameType && $room['gameType'] !== $gameType) continue;

            $playerNames = [];
            foreach ($room['players'] as $connId) {
                $player = $this->getPlayer($connId);
                if ($player) $playerNames[] = $player['name'];
            }

            $list[] = [
                'id'          => $room['id'],
                'name'        => $room['name'],
                'gameType'    => $room['gameType'],
                'status'      => $room['status'],
                'playerCount' => count($room['players']),
                'maxPlayers'  => $this->maxPlayersPerRoom,
                'spectatorCount' => count($room['spectators'] ?? []),
                'players'     => $playerNames,
                'createdAt'   => $room['createdAt'],
            ];
        }
        return $list;
    }

    /**
     * 清理闲置房间
     */
    public function cleanupIdleRooms(int $maxIdleSeconds = 1800): int
    {
        $now = time();
        $cleaned = 0;

        foreach ($this->rooms as $roomId => $room) {
            if (($now - $room['updatedAt']) > $maxIdleSeconds) {
                // 通知房间内所有玩家
                foreach ($room['players'] as $connId) {
                    unset($this->connectionRooms[$connId]);
                }
                unset($this->rooms[$roomId]);
                $cleaned++;
                Logger::info("清理闲置房间: {$roomId}");
            }
        }

        return $cleaned;
    }

    /**
     * 获取统计信息
     */
    public function getStats(): array
    {
        return [
            'totalRooms'    => count($this->rooms),
            'totalPlayers'  => count($this->players),
            'waitingRooms'  => count(array_filter($this->rooms, fn($r) => $r['status'] === 'waiting')),
            'playingRooms'  => count(array_filter($this->rooms, fn($r) => $r['status'] === 'playing')),
        ];
    }

    private function generateRoomId(): string
    {
        return substr(md5(uniqid((string)mt_rand(), true)), 0, 8);
    }
}
