<?php
/**
 * 简单日志工具
 */

namespace App;

class Logger
{
    private static string $level = 'info';
    private static bool $enabled = true;

    private static array $levels = [
        'debug' => 0,
        'info'  => 1,
        'warn'  => 2,
        'error' => 3,
    ];

    public static function init(array $config): void
    {
        self::$enabled = $config['enabled'] ?? true;
        self::$level = $config['level'] ?? 'info';
    }

    public static function debug(string $message, array $context = []): void
    {
        self::log('debug', $message, $context);
    }

    public static function info(string $message, array $context = []): void
    {
        self::log('info', $message, $context);
    }

    public static function warn(string $message, array $context = []): void
    {
        self::log('warn', $message, $context);
    }

    public static function error(string $message, array $context = []): void
    {
        self::log('error', $message, $context);
    }

    private static function log(string $level, string $message, array $context): void
    {
        if (!self::$enabled) return;
        if ((self::$levels[$level] ?? 0) < (self::$levels[self::$level] ?? 0)) return;

        $time = date('H:i:s');
        $tag = strtoupper($level);
        $contextStr = $context ? ' ' . json_encode($context, JSON_UNESCAPED_UNICODE) : '';
        echo "[{$time}][{$tag}] {$message}{$contextStr}\n";
    }
}
