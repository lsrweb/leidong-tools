/**
 * 缓存管理模块
 * 提供高效的缓存机制，支持多种缓存策略
 */
import * as vscode from 'vscode';
import { handleCacheError } from '../errors/errorHandler';

// 缓存项接口
export interface CacheItem<T> {
    data: T;
    timestamp: number;
    expiresAt?: number;
    accessCount: number;
    lastAccessed: number;
}

// 缓存配置
export interface CacheConfig {
    maxSize: number;
    ttl: number; // 生存时间（毫秒）
    cleanupInterval: number; // 清理间隔（毫秒）
}

// 默认缓存配置
const DEFAULT_CACHE_CONFIG: CacheConfig = {
    maxSize: 1000,
    ttl: 5 * 60 * 1000, // 5分钟
    cleanupInterval: 60 * 1000 // 1分钟
};

/**
 * 通用缓存管理器
 */
export class CacheManager<T> {
    private cache = new Map<string, CacheItem<T>>();
    private config: CacheConfig;
    private cleanupTimer?: NodeJS.Timeout;

    constructor(config: Partial<CacheConfig> = {}) {
        this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
        this.startCleanupTimer();
    }

    /**
     * 设置缓存项
     */
    public set(key: string, data: T, ttl?: number): void {
        try {
            const now = Date.now();
            const expiresAt = ttl ? now + ttl : this.config.ttl ? now + this.config.ttl : undefined;

            const cacheItem: CacheItem<T> = {
                data,
                timestamp: now,
                expiresAt,
                accessCount: 0,
                lastAccessed: now
            };

            // 如果缓存已满，删除最旧的项
            if (this.cache.size >= this.config.maxSize) {
                this.evictOldest();
            }

            this.cache.set(key, cacheItem);
        } catch (error) {
            handleCacheError(error instanceof Error ? error : new Error(String(error)), 'set');
        }
    }

    /**
     * 获取缓存项
     */
    public get(key: string): T | null {
        try {
            const item = this.cache.get(key);
            if (!item) {
                return null;
            }

            // 检查是否过期
            if (item.expiresAt && Date.now() > item.expiresAt) {
                this.cache.delete(key);
                return null;
            }

            // 更新访问统计
            item.accessCount++;
            item.lastAccessed = Date.now();

            return item.data;
        } catch (error) {
            handleCacheError(error instanceof Error ? error : new Error(String(error)), 'get');
            return null;
        }
    }

    /**
     * 检查缓存项是否存在
     */
    public has(key: string): boolean {
        try {
            const item = this.cache.get(key);
            if (!item) {
                return false;
            }

            // 检查是否过期
            if (item.expiresAt && Date.now() > item.expiresAt) {
                this.cache.delete(key);
                return false;
            }

            return true;
        } catch (error) {
            handleCacheError(error instanceof Error ? error : new Error(String(error)), 'has');
            return false;
        }
    }

    /**
     * 删除缓存项
     */
    public delete(key: string): boolean {
        try {
            return this.cache.delete(key);
        } catch (error) {
            handleCacheError(error instanceof Error ? error : new Error(String(error)), 'delete');
            return false;
        }
    }

    /**
     * 清空所有缓存
     */
    public clear(): void {
        try {
            this.cache.clear();
        } catch (error) {
            handleCacheError(error instanceof Error ? error : new Error(String(error)), 'clear');
        }
    }

    /**
     * 获取缓存大小
     */
    public size(): number {
        return this.cache.size;
    }

    /**
     * 获取缓存统计信息
     */
    public getStats(): {
        size: number;
        maxSize: number;
        hitRate: number;
        totalAccesses: number;
        averageAccessCount: number;
    } {
        const items = Array.from(this.cache.values());
        const totalAccesses = items.reduce((sum, item) => sum + item.accessCount, 0);
        const averageAccessCount = items.length > 0 ? totalAccesses / items.length : 0;

        return {
            size: this.cache.size,
            maxSize: this.config.maxSize,
            hitRate: 0, // 需要外部跟踪
            totalAccesses,
            averageAccessCount
        };
    }

    /**
     * 删除最旧的缓存项
     */
    private evictOldest(): void {
        let oldestKey: string | null = null;
        let oldestTime = Date.now();

        for (const [key, item] of this.cache.entries()) {
            if (item.lastAccessed < oldestTime) {
                oldestTime = item.lastAccessed;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
        }
    }

    /**
     * 清理过期项
     */
    private cleanup(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];

        for (const [key, item] of this.cache.entries()) {
            if (item.expiresAt && now > item.expiresAt) {
                expiredKeys.push(key);
            }
        }

        expiredKeys.forEach(key => this.cache.delete(key));

        if (expiredKeys.length > 0) {
            console.log(`[Cache Manager] 清理了 ${expiredKeys.length} 个过期项`);
        }
    }

    /**
     * 启动清理定时器
     */
    private startCleanupTimer(): void {
        if (this.config.cleanupInterval > 0) {
            this.cleanupTimer = setInterval(() => {
                this.cleanup();
            }, this.config.cleanupInterval);
        }
    }

    /**
     * 停止清理定时器
     */
    public dispose(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        this.clear();
    }
}

/**
 * AST索引缓存管理器
 */
export class ASTIndexCacheManager {
    private static instance: ASTIndexCacheManager;
    private cache: CacheManager<any[]>;

    private constructor() {
        this.cache = new CacheManager<any[]>({
            maxSize: 500,
            ttl: 10 * 60 * 1000, // 10分钟
            cleanupInterval: 2 * 60 * 1000 // 2分钟
        });
    }

    public static getInstance(): ASTIndexCacheManager {
        if (!ASTIndexCacheManager.instance) {
            ASTIndexCacheManager.instance = new ASTIndexCacheManager();
        }
        return ASTIndexCacheManager.instance;
    }

    /**
     * 设置AST索引缓存
     */
    public setIndex(content: string, index: any[]): void {
        this.cache.set(content, index);
    }

    /**
     * 获取AST索引缓存
     */
    public getIndex(content: string): any[] | null {
        return this.cache.get(content);
    }

    /**
     * 检查AST索引缓存是否存在
     */
    public hasIndex(content: string): boolean {
        return this.cache.has(content);
    }

    /**
     * 清理AST索引缓存
     */
    public clear(): void {
        this.cache.clear();
    }

    /**
     * 获取缓存统计
     */
    public getStats() {
        return this.cache.getStats();
    }

    /**
     * 销毁缓存管理器
     */
    public dispose(): void {
        this.cache.dispose();
    }
}

/**
 * 文档解析缓存管理器
 */
export class DocumentParseCacheManager {
    private static instance: DocumentParseCacheManager;
    private cache: CacheManager<any>;

    private constructor() {
        this.cache = new CacheManager<any>({
            maxSize: 200,
            ttl: 5 * 60 * 1000, // 5分钟
            cleanupInterval: 60 * 1000 // 1分钟
        });
    }

    public static getInstance(): DocumentParseCacheManager {
        if (!DocumentParseCacheManager.instance) {
            DocumentParseCacheManager.instance = new DocumentParseCacheManager();
        }
        return DocumentParseCacheManager.instance;
    }

    /**
     * 设置文档解析缓存
     */
    public setParseResult(uri: string, result: any): void {
        this.cache.set(uri, result);
    }

    /**
     * 获取文档解析缓存
     */
    public getParseResult(uri: string): any | null {
        return this.cache.get(uri);
    }

    /**
     * 检查文档解析缓存是否存在
     */
    public hasParseResult(uri: string): boolean {
        return this.cache.has(uri);
    }

    /**
     * 清理文档解析缓存
     */
    public clear(): void {
        this.cache.clear();
    }

    /**
     * 获取缓存统计
     */
    public getStats() {
        return this.cache.getStats();
    }

    /**
     * 销毁缓存管理器
     */
    public dispose(): void {
        this.cache.dispose();
    }
}

// 导出单例实例
export const astIndexCache = ASTIndexCacheManager.getInstance();
export const documentParseCache = DocumentParseCacheManager.getInstance(); 
