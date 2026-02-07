<?php
/**
 * 五子棋游戏逻辑
 * 15x15 棋盘，五子连珠获胜
 */

namespace App\Games;

class Gomoku
{
    const BOARD_SIZE = 15;
    const EMPTY = 0;
    const BLACK = 1;  // 先手
    const WHITE = 2;

    private array $board;
    private int $currentPlayer;
    private ?int $winner;
    private array $moves;
    private array $playerMap;  // connId => BLACK|WHITE
    private bool $finished;
    private ?array $winLine;   // 获胜连线坐标

    public function __construct()
    {
        $this->reset();
    }

    /**
     * 重置游戏
     */
    public function reset(): void
    {
        $this->board = array_fill(0, self::BOARD_SIZE, array_fill(0, self::BOARD_SIZE, self::EMPTY));
        $this->currentPlayer = self::BLACK;
        $this->winner = null;
        $this->moves = [];
        $this->playerMap = [];
        $this->finished = false;
        $this->winLine = null;
    }

    /**
     * 分配玩家颜色（先加入的执黑先手）
     */
    public function assignPlayers(array $connIds): void
    {
        if (count($connIds) >= 2) {
            // 随机分配黑白
            $shuffled = $connIds;
            shuffle($shuffled);
            $this->playerMap[$shuffled[0]] = self::BLACK;
            $this->playerMap[$shuffled[1]] = self::WHITE;
        }
    }

    /**
     * 获取玩家颜色
     */
    public function getPlayerColor(int $connId): ?int
    {
        return $this->playerMap[$connId] ?? null;
    }

    /**
     * 获取玩家颜色名
     */
    public function getPlayerColorName(int $connId): string
    {
        $color = $this->getPlayerColor($connId);
        return match ($color) {
            self::BLACK => 'black',
            self::WHITE => 'white',
            default => 'spectator',
        };
    }

    /**
     * 根据颜色名获取 connId
     */
    public function getConnIdByColorName(string $colorName): ?int
    {
        $target = $colorName === 'black' ? self::BLACK : self::WHITE;
        foreach ($this->playerMap as $connId => $color) {
            if ($color === $target) return $connId;
        }
        return null;
    }

    /**
     * 落子
     */
    public function makeMove(int $connId, int $row, int $col): array
    {
        // 检查游戏是否结束
        if ($this->finished) {
            return ['success' => false, 'error' => '游戏已结束'];
        }

        // 检查是否是该玩家的回合
        $playerColor = $this->getPlayerColor($connId);
        if ($playerColor === null) {
            return ['success' => false, 'error' => '你不是参与者'];
        }
        if ($playerColor !== $this->currentPlayer) {
            return ['success' => false, 'error' => '还没轮到你'];
        }

        // 检查坐标合法
        if ($row < 0 || $row >= self::BOARD_SIZE || $col < 0 || $col >= self::BOARD_SIZE) {
            return ['success' => false, 'error' => '坐标越界'];
        }

        // 检查位置为空
        if ($this->board[$row][$col] !== self::EMPTY) {
            return ['success' => false, 'error' => '该位置已有棋子'];
        }

        // 放置棋子
        $this->board[$row][$col] = $this->currentPlayer;
        $this->moves[] = [
            'row'    => $row,
            'col'    => $col,
            'color'  => $this->currentPlayer,
            'connId' => $connId,
            'time'   => time(),
        ];

        // 检查胜负
        $result = [
            'success' => true,
            'row'     => $row,
            'col'     => $col,
            'color'   => $this->currentPlayer === self::BLACK ? 'black' : 'white',
            'winner'  => null,
            'winLine' => null,
            'isDraw'  => false,
        ];

        if ($this->checkWin($row, $col)) {
            $this->winner = $this->currentPlayer;
            $this->finished = true;
            $result['winner'] = $this->currentPlayer === self::BLACK ? 'black' : 'white';
            $result['winLine'] = $this->winLine;
        } elseif ($this->isDraw()) {
            $this->finished = true;
            $result['isDraw'] = true;
        }

        // 切换玩家
        $this->currentPlayer = ($this->currentPlayer === self::BLACK) ? self::WHITE : self::BLACK;

        return $result;
    }

    /**
     * 检查是否五子连珠
     */
    private function checkWin(int $row, int $col): bool
    {
        $color = $this->board[$row][$col];
        $directions = [
            [0, 1],   // 水平
            [1, 0],   // 垂直
            [1, 1],   // 主对角线
            [1, -1],  // 副对角线
        ];

        foreach ($directions as [$dr, $dc]) {
            $line = [[$row, $col]];

            // 正方向
            for ($i = 1; $i < 5; $i++) {
                $r = $row + $dr * $i;
                $c = $col + $dc * $i;
                if ($r < 0 || $r >= self::BOARD_SIZE || $c < 0 || $c >= self::BOARD_SIZE) break;
                if ($this->board[$r][$c] !== $color) break;
                $line[] = [$r, $c];
            }

            // 反方向
            for ($i = 1; $i < 5; $i++) {
                $r = $row - $dr * $i;
                $c = $col - $dc * $i;
                if ($r < 0 || $r >= self::BOARD_SIZE || $c < 0 || $c >= self::BOARD_SIZE) break;
                if ($this->board[$r][$c] !== $color) break;
                $line[] = [$r, $c];
            }

            if (count($line) >= 5) {
                $this->winLine = $line;
                return true;
            }
        }

        return false;
    }

    /**
     * 检查平局（棋盘满了）
     */
    private function isDraw(): bool
    {
        foreach ($this->board as $row) {
            foreach ($row as $cell) {
                if ($cell === self::EMPTY) return false;
            }
        }
        return true;
    }

    /**
     * 获取游戏状态（用于同步）
     */
    public function getState(): array
    {
        $colorMap = [];
        foreach ($this->playerMap as $connId => $color) {
            $colorMap[$connId] = $color === self::BLACK ? 'black' : 'white';
        }

        return [
            'board'         => $this->board,
            'currentPlayer' => $this->currentPlayer === self::BLACK ? 'black' : 'white',
            'winner'        => $this->winner ? ($this->winner === self::BLACK ? 'black' : 'white') : null,
            'winLine'       => $this->winLine,
            'finished'      => $this->finished,
            'moveCount'     => count($this->moves),
            'playerMap'     => $colorMap,
            'isDraw'        => $this->finished && $this->winner === null,
        ];
    }

    /**
     * 获取最后一步棋
     */
    public function getLastMove(): ?array
    {
        return empty($this->moves) ? null : end($this->moves);
    }

    /**
     * 获取步数
     */
    public function getMoveCount(): int
    {
        return count($this->moves);
    }

    /**
     * 游戏是否结束
     */
    public function isFinished(): bool
    {
        return $this->finished;
    }
}
