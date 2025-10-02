/**
 * 性能监控模块
 * 用于跟踪和优化变量跳转的性能
 */
import * as vscode from 'vscode';

// 性能指标接口
export interface PerformanceMetric {
    operation: string;
    duration: number;
    timestamp: number;
    success: boolean;
    details?: {
        fileSize?: number;
        cacheHit?: boolean;
        itemsFound?: number;
        error?: string;
    };
}

// 性能统计接口
export interface PerformanceStats {
    totalOperations: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    successRate: number;
    cacheHitRate: number;
    recentMetrics: PerformanceMetric[];
}

/**
 * 性能监控装饰器
 */
// 宽松类型以兼容 TS 新旧装饰器实现
export function monitor(operation: string): any {
    // Support both legacy (experimentalDecorators) and new TC39 stage-3 decorator semantics
    return function (...decoratorArgs: any[]) {
        // New decorator: (value, context)
        if (decoratorArgs.length === 2 && typeof decoratorArgs[1] === 'object' && decoratorArgs[1] !== null && 'kind' in decoratorArgs[1]) {
            const [value, context] = decoratorArgs as [Function, any];
            if (context.kind !== 'method') {
                return value; // Only wrap methods
            }
            return async function(this: any, ...args: any[]) {
                const stopTimer = performanceMonitor.startTimer(operation);
                try {
                    const result = await value.apply(this, args);
                    stopTimer(true);
                    return result;
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    stopTimer(false, { error: errorMessage });
                    console.error(`[Performance] Operation "${operation}" failed: ${errorMessage}`);
                    throw error;
                }
            };
        }

        // Legacy decorator: (target, propertyKey, descriptor)
        const [target, propertyKey, descriptor] = decoratorArgs as [any, string | symbol, PropertyDescriptor | undefined];
        if (!descriptor || typeof descriptor.value !== 'function') {
            // Fallback: nothing to wrap to avoid runtime error
            return;
        }
        const original = descriptor.value;
        descriptor.value = async function(this: any, ...args: any[]) {
            const stopTimer = performanceMonitor.startTimer(operation);
            try {
                const result = await original.apply(this, args);
                stopTimer(true);
                return result;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                stopTimer(false, { error: errorMessage });
                console.error(`[Performance] Operation "${operation}" failed: ${errorMessage}`);
                throw error;
            }
        };
    };
}

/**
 * 性能监控器类
 */
export class PerformanceMonitor {
    private static instance: PerformanceMonitor;
    private metrics: PerformanceMetric[] = [];
    private maxMetrics = 1000;
    private cacheHits = 0;
    private totalCacheAccesses = 0;

    private constructor() {}

    /**
     * 获取单例实例
     */
    public static getInstance(): PerformanceMonitor {
        if (!PerformanceMonitor.instance) {
            PerformanceMonitor.instance = new PerformanceMonitor();
        }
        return PerformanceMonitor.instance;
    }

    /**
     * 开始性能监控
     */
    public startTimer(operation: string): (success?: boolean, details?: PerformanceMetric['details']) => void {
        const startTime = Date.now();
        
        return (success: boolean = true, details?: PerformanceMetric['details']) => {
            const duration = Date.now() - startTime;
            this.recordMetric(operation, duration, success, details);
        };
    }

    /**
     * 记录性能指标
     */
    public recordMetric(
        operation: string,
        duration: number,
        success: boolean,
        details?: PerformanceMetric['details']
    ): void {
        const metric: PerformanceMetric = {
            operation,
            duration,
            timestamp: Date.now(),
            success,
            details
        };

        this.metrics.push(metric);

        // 限制指标数量
        if (this.metrics.length > this.maxMetrics) {
            this.metrics = this.metrics.slice(-this.maxMetrics);
        }

        // 记录缓存命中
        if (details?.cacheHit) {
            this.cacheHits++;
        }
        if (details?.cacheHit !== undefined) {
            this.totalCacheAccesses++;
        }

        // 记录慢操作
        if (duration > 1000) { // 超过1秒的操作
            console.warn(`[Performance] 慢操作检测: ${operation} 耗时 ${duration}ms`);
        }
    }

    /**
     * 记录缓存命中
     */
    public recordCacheHit(): void {
        this.cacheHits++;
        this.totalCacheAccesses++;
    }

    /**
     * 记录缓存未命中
     */
    public recordCacheMiss(): void {
        this.totalCacheAccesses++;
    }

    /**
     * 获取性能统计
     */
    public getStats(operation?: string): PerformanceStats {
        const filteredMetrics = operation 
            ? this.metrics.filter(m => m.operation === operation)
            : this.metrics;

        if (filteredMetrics.length === 0) {
            return {
                totalOperations: 0,
                averageDuration: 0,
                minDuration: 0,
                maxDuration: 0,
                successRate: 0,
                cacheHitRate: 0,
                recentMetrics: []
            };
        }

        const durations = filteredMetrics.map(m => m.duration);
        const successful = filteredMetrics.filter(m => m.success);
        const cacheHits = filteredMetrics.filter(m => m.details?.cacheHit).length;

        return {
            totalOperations: filteredMetrics.length,
            averageDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
            minDuration: Math.min(...durations),
            maxDuration: Math.max(...durations),
            successRate: successful.length / filteredMetrics.length,
            cacheHitRate: this.totalCacheAccesses > 0 ? this.cacheHits / this.totalCacheAccesses : 0,
            recentMetrics: filteredMetrics.slice(-10)
        };
    }

    /**
     * 获取特定操作的性能统计
     */
    public getOperationStats(operation: string): PerformanceStats {
        return this.getStats(operation);
    }

    /**
     * 获取所有操作的性能统计
     */
    public getAllStats(): PerformanceStats {
        return this.getStats();
    }

    /**
     * 获取慢操作列表
     */
    public getSlowOperations(threshold: number = 500): PerformanceMetric[] {
        return this.metrics.filter(m => m.duration > threshold);
    }

    /**
     * 获取失败的操作
     */
    public getFailedOperations(): PerformanceMetric[] {
        return this.metrics.filter(m => !m.success);
    }

    /**
     * 清空性能指标
     */
    public clear(): void {
        this.metrics = [];
        this.cacheHits = 0;
        this.totalCacheAccesses = 0;
    }

    /**
     * 输出性能报告
     */
    public generateReport(): string {
        const stats = this.getAllStats();
        const slowOps = this.getSlowOperations();
        const failedOps = this.getFailedOperations();

        let report = '=== 性能监控报告 ===\n';
        report += `总操作数: ${stats.totalOperations}\n`;
        report += `平均耗时: ${stats.averageDuration.toFixed(2)}ms\n`;
        report += `最小耗时: ${stats.minDuration}ms\n`;
        report += `最大耗时: ${stats.maxDuration}ms\n`;
        report += `成功率: ${(stats.successRate * 100).toFixed(2)}%\n`;
        report += `缓存命中率: ${(stats.cacheHitRate * 100).toFixed(2)}%\n`;
        report += `慢操作数 (>500ms): ${slowOps.length}\n`;
        report += `失败操作数: ${failedOps.length}\n`;

        if (slowOps.length > 0) {
            report += '\n=== 慢操作列表 ===\n';
            slowOps.slice(-5).forEach(op => {
                report += `${op.operation}: ${op.duration}ms (${op.success ? '成功' : '失败'})\n`;
            });
        }

        if (failedOps.length > 0) {
            report += '\n=== 失败操作列表 ===\n';
            failedOps.slice(-5).forEach(op => {
                report += `${op.operation}: ${op.duration}ms - ${op.details?.error || '未知错误'}\n`;
            });
        }

        return report;
    }

    /**
     * 显示性能报告
     */
    public async showReport(): Promise<void> {
        const report = this.generateReport();
        const document = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(document);
    }
}

// 导出单例实例
export const performanceMonitor = PerformanceMonitor.getInstance();

/**
 * 便捷的性能监控函数
 */
export async function withPerformanceMonitoring<T>(
    operation: string,
    fn: () => Promise<T> | T
): Promise<T> {
    const stopTimer = performanceMonitor.startTimer(operation);
    
    try {
        const result = await fn();
        stopTimer(true);
        return result;
    } catch (error) {
        stopTimer(false, { error: error instanceof Error ? error.message : String(error) });
        throw error;
    }
} 
