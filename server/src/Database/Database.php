<?php
/**
 * SQLite 数据库管理器
 * 
 * 负责：
 *   - 数据库初始化与迁移
 *   - 玩家持久化（uid、昵称、设备码冲突处理）
 *   - 游戏记录存储
 *   - 房间历史
 */

namespace App\Database;

use App\Logger;

class Database
{
    private \SQLite3 $db;
    private static ?Database $instance = null;

    private function __construct(string $dbPath)
    {
        $dir = dirname($dbPath);
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        $this->db = new \SQLite3($dbPath);
        $this->db->busyTimeout(5000);
        $this->db->exec('PRAGMA journal_mode = WAL');
        $this->db->exec('PRAGMA synchronous = NORMAL');
        $this->db->exec('PRAGMA foreign_keys = ON');

        $this->migrate();
        Logger::info("SQLite 数据库已初始化: {$dbPath}");
    }

    /**
     * 获取单例实例
     */
    public static function getInstance(string $dbPath = ''): self
    {
        if (self::$instance === null) {
            if (!$dbPath) {
                $dbPath = __DIR__ . '/../../data/game.db';
            }
            self::$instance = new self($dbPath);
        }
        return self::$instance;
    }

    /**
     * 数据库迁移 - 创建/更新表结构
     */
    private function migrate(): void
    {
        // 玩家表：持久化存储玩家身份
        $this->db->exec('
            CREATE TABLE IF NOT EXISTS players (
                uid TEXT PRIMARY KEY,
                nickname TEXT NOT NULL DEFAULT "玩家",
                original_device_hash TEXT NOT NULL,
                device_conflict_seq INTEGER NOT NULL DEFAULT 0,
                total_games INTEGER NOT NULL DEFAULT 0,
                total_wins INTEGER NOT NULL DEFAULT 0,
                total_draws INTEGER NOT NULL DEFAULT 0,
                last_seen_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            )
        ');

        // 设备码索引（用于冲突检测）
        $this->db->exec('
            CREATE INDEX IF NOT EXISTS idx_players_device_hash 
            ON players(original_device_hash)
        ');

        // 游戏记录表
        $this->db->exec('
            CREATE TABLE IF NOT EXISTS game_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                game_type TEXT NOT NULL DEFAULT "gomoku",
                player1_uid TEXT NOT NULL,
                player2_uid TEXT NOT NULL,
                winner_uid TEXT,
                is_draw INTEGER NOT NULL DEFAULT 0,
                moves_count INTEGER NOT NULL DEFAULT 0,
                duration_seconds INTEGER NOT NULL DEFAULT 0,
                finished_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            )
        ');

        $this->db->exec('
            CREATE INDEX IF NOT EXISTS idx_game_records_player1 
            ON game_records(player1_uid)
        ');
        $this->db->exec('
            CREATE INDEX IF NOT EXISTS idx_game_records_player2 
            ON game_records(player2_uid)
        ');

        Logger::debug("数据库迁移完成");
    }

    // ─── 玩家管理 ───

    /**
     * 注册或更新玩家
     * 
     * @param string $uid 客户端生成的设备码
     * @param string $nickname 昵称
     * @param string $deviceHash 原始设备哈希（用于冲突检测）
     * @return array 玩家信息（uid 可能因冲突而改变）
     */
    public function registerPlayer(string $uid, string $nickname, string $deviceHash = ''): array
    {
        if (!$deviceHash) {
            $deviceHash = $uid;
        }

        $existing = $this->getPlayer($uid);
        if ($existing) {
            // 已存在的玩家，更新昵称和最后在线时间
            $stmt = $this->db->prepare("
                UPDATE players SET nickname = :nickname, last_seen_at = :now
                WHERE uid = :uid
            ");
            $stmt->bindValue(':nickname', $nickname, SQLITE3_TEXT);
            $stmt->bindValue(':now', time(), SQLITE3_INTEGER);
            $stmt->bindValue(':uid', $uid, SQLITE3_TEXT);
            $stmt->execute();

            $existing['nickname'] = $nickname;
            $existing['last_seen_at'] = time();
            return $existing;
        }

        // 新玩家，直接插入
        $now = time();
        $stmt = $this->db->prepare('
            INSERT INTO players (uid, nickname, original_device_hash, device_conflict_seq, last_seen_at, created_at)
            VALUES (:uid, :nickname, :device_hash, 0, :now, :now)
        ');
        $stmt->bindValue(':uid', $uid, SQLITE3_TEXT);
        $stmt->bindValue(':nickname', $nickname, SQLITE3_TEXT);
        $stmt->bindValue(':device_hash', $deviceHash, SQLITE3_TEXT);
        $stmt->bindValue(':now', $now, SQLITE3_INTEGER);
        $stmt->execute();

        return [
            'uid' => $uid,
            'nickname' => $nickname,
            'original_device_hash' => $deviceHash,
            'device_conflict_seq' => 0,
            'total_games' => 0,
            'total_wins' => 0,
            'total_draws' => 0,
            'last_seen_at' => $now,
            'created_at' => $now,
        ];
    }

    /**
     * 检查 UID 是否已被占用（设备码冲突检测）
     * 
     * 如果 uid 已存在且不是同一设备来源，说明两台机器生成了相同 hash。
     * 返回一个新的唯一 uid。
     * 
     * @param string $uid 客户端提交的 uid
     * @param string $deviceHash 客户端原始设备哈希
     * @return array ['conflict' => bool, 'uid' => string, 'seq' => int]
     */
    public function resolveUidConflict(string $uid, string $deviceHash): array
    {
        $existing = $this->getPlayer($uid);

        // uid 不存在，无冲突
        if (!$existing) {
            return ['conflict' => false, 'uid' => $uid, 'seq' => 0];
        }

        // uid 存在，且设备哈希匹配 → 这是同一个人
        if ($existing['original_device_hash'] === $deviceHash) {
            return ['conflict' => false, 'uid' => $uid, 'seq' => 0];
        }

        // 冲突！查找该设备哈希是否已经有分配过的 uid
        $existingDevice = $this->findPlayerByDeviceHash($deviceHash);
        if ($existingDevice) {
            // 该设备之前已经分配过新 uid，直接返回
            return [
                'conflict' => true,
                'uid' => $existingDevice['uid'],
                'seq' => $existingDevice['device_conflict_seq'],
            ];
        }

        // 该设备是首次冲突，生成新的 uid
        // 策略：在原始 uid 后追加冲突序号的哈希
        $seq = $this->getNextConflictSeq($uid);
        $newUid = $this->generateConflictUid($deviceHash, $seq);

        return [
            'conflict' => true,
            'uid' => $newUid,
            'seq' => $seq,
        ];
    }

    /**
     * 根据设备哈希查找已注册的玩家
     */
    public function findPlayerByDeviceHash(string $deviceHash): ?array
    {
        $stmt = $this->db->prepare('
            SELECT * FROM players WHERE original_device_hash = :hash LIMIT 1
        ');
        $stmt->bindValue(':hash', $deviceHash, SQLITE3_TEXT);
        $result = $stmt->execute();
        $row = $result->fetchArray(SQLITE3_ASSOC);
        return $row ?: null;
    }

    /**
     * 获取玩家信息
     */
    public function getPlayer(string $uid): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM players WHERE uid = :uid');
        $stmt->bindValue(':uid', $uid, SQLITE3_TEXT);
        $result = $stmt->execute();
        $row = $result->fetchArray(SQLITE3_ASSOC);
        return $row ?: null;
    }

    /**
     * 更新玩家昵称
     */
    public function updateNickname(string $uid, string $nickname): void
    {
        $stmt = $this->db->prepare('UPDATE players SET nickname = :name, last_seen_at = :now WHERE uid = :uid');
        $stmt->bindValue(':name', $nickname, SQLITE3_TEXT);
        $stmt->bindValue(':now', time(), SQLITE3_INTEGER);
        $stmt->bindValue(':uid', $uid, SQLITE3_TEXT);
        $stmt->execute();
    }

    /**
     * 更新玩家最后在线时间
     */
    public function touchPlayer(string $uid): void
    {
        $stmt = $this->db->prepare('UPDATE players SET last_seen_at = :now WHERE uid = :uid');
        $stmt->bindValue(':now', time(), SQLITE3_INTEGER);
        $stmt->bindValue(':uid', $uid, SQLITE3_TEXT);
        $stmt->execute();
    }

    // ─── 游戏记录 ───

    /**
     * 保存游戏记录
     */
    public function saveGameRecord(array $record): int
    {
        $now = time();
        $stmt = $this->db->prepare('
            INSERT INTO game_records 
                (room_id, game_type, player1_uid, player2_uid, winner_uid, is_draw, moves_count, duration_seconds, finished_at, created_at)
            VALUES 
                (:room_id, :game_type, :p1, :p2, :winner, :draw, :moves, :duration, :finished, :now)
        ');
        $stmt->bindValue(':room_id', $record['room_id'], SQLITE3_TEXT);
        $stmt->bindValue(':game_type', $record['game_type'] ?? 'gomoku', SQLITE3_TEXT);
        $stmt->bindValue(':p1', $record['player1_uid'], SQLITE3_TEXT);
        $stmt->bindValue(':p2', $record['player2_uid'], SQLITE3_TEXT);
        $stmt->bindValue(':winner', $record['winner_uid'] ?? null, SQLITE3_TEXT);
        $stmt->bindValue(':draw', $record['is_draw'] ? 1 : 0, SQLITE3_INTEGER);
        $stmt->bindValue(':moves', $record['moves_count'] ?? 0, SQLITE3_INTEGER);
        $stmt->bindValue(':duration', $record['duration_seconds'] ?? 0, SQLITE3_INTEGER);
        $stmt->bindValue(':finished', $record['finished_at'] ?? $now, SQLITE3_INTEGER);
        $stmt->bindValue(':now', $now, SQLITE3_INTEGER);
        $stmt->execute();

        $gameId = $this->db->lastInsertRowID();

        // 更新玩家统计
        $this->incrementPlayerStats($record['player1_uid'], $record);
        $this->incrementPlayerStats($record['player2_uid'], $record);

        return $gameId;
    }

    /**
     * 获取玩家战绩
     */
    public function getPlayerStats(string $uid): array
    {
        $player = $this->getPlayer($uid);
        if (!$player) {
            return ['total_games' => 0, 'total_wins' => 0, 'total_draws' => 0, 'win_rate' => 0];
        }

        $winRate = $player['total_games'] > 0
            ? round($player['total_wins'] / $player['total_games'] * 100, 1)
            : 0;

        return [
            'total_games' => $player['total_games'],
            'total_wins' => $player['total_wins'],
            'total_draws' => $player['total_draws'],
            'total_losses' => $player['total_games'] - $player['total_wins'] - $player['total_draws'],
            'win_rate' => $winRate,
        ];
    }

    /**
     * 获取最近游戏记录
     */
    public function getRecentGames(string $uid, int $limit = 10): array
    {
        $stmt = $this->db->prepare('
            SELECT * FROM game_records 
            WHERE player1_uid = :uid OR player2_uid = :uid
            ORDER BY finished_at DESC 
            LIMIT :limit
        ');
        $stmt->bindValue(':uid', $uid, SQLITE3_TEXT);
        $stmt->bindValue(':limit', $limit, SQLITE3_INTEGER);
        $result = $stmt->execute();

        $records = [];
        while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
            $records[] = $row;
        }
        return $records;
    }

    /**
     * 获取排行榜
     */
    public function getLeaderboard(int $limit = 20): array
    {
        $stmt = $this->db->prepare('
            SELECT uid, nickname, total_games, total_wins, total_draws,
                   CASE WHEN total_games > 0 
                        THEN ROUND(CAST(total_wins AS REAL) / total_games * 100, 1)
                        ELSE 0 END as win_rate
            FROM players 
            WHERE total_games >= 1
            ORDER BY total_wins DESC, win_rate DESC
            LIMIT :limit
        ');
        $stmt->bindValue(':limit', $limit, SQLITE3_INTEGER);
        $result = $stmt->execute();

        $list = [];
        while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
            $list[] = $row;
        }
        return $list;
    }

    // ─── 内部方法 ───

    /**
     * 获取下一个冲突序号
     */
    private function getNextConflictSeq(string $originalUid): int
    {
        $stmt = $this->db->prepare('
            SELECT MAX(device_conflict_seq) as max_seq FROM players 
            WHERE original_device_hash IN (
                SELECT original_device_hash FROM players WHERE uid = :uid
            )
        ');
        $stmt->bindValue(':uid', $originalUid, SQLITE3_TEXT);
        $result = $stmt->execute();
        $row = $result->fetchArray(SQLITE3_ASSOC);
        return ($row['max_seq'] ?? 0) + 1;
    }

    /**
     * 为冲突设备生成新的 uid
     * 策略：SHA-256(deviceHash + ':conflict:' + seq) 取前16位
     */
    private function generateConflictUid(string $deviceHash, int $seq): string
    {
        return substr(hash('sha256', $deviceHash . ':conflict:' . $seq), 0, 16);
    }

    /**
     * 增加玩家统计数据
     */
    private function incrementPlayerStats(string $uid, array $record): void
    {
        $isWinner = ($record['winner_uid'] ?? '') === $uid;
        $isDraw = !empty($record['is_draw']);

        $winInc = $isWinner ? 1 : 0;
        $drawInc = $isDraw ? 1 : 0;

        $stmt = $this->db->prepare('
            UPDATE players SET 
                total_games = total_games + 1,
                total_wins = total_wins + :win,
                total_draws = total_draws + :draw
            WHERE uid = :uid
        ');
        $stmt->bindValue(':win', $winInc, SQLITE3_INTEGER);
        $stmt->bindValue(':draw', $drawInc, SQLITE3_INTEGER);
        $stmt->bindValue(':uid', $uid, SQLITE3_TEXT);
        $stmt->execute();
    }

    /**
     * 获取统计概览
     */
    public function getGlobalStats(): array
    {
        $playerCount = $this->db->querySingle('SELECT COUNT(*) FROM players');
        $gameCount = $this->db->querySingle('SELECT COUNT(*) FROM game_records');
        return [
            'totalRegisteredPlayers' => $playerCount,
            'totalGamesPlayed' => $gameCount,
        ];
    }

    /**
     * 关闭数据库连接
     */
    public function close(): void
    {
        $this->db->close();
        self::$instance = null;
    }
}
