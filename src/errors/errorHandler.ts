/**
 * 错误处理模块
 * 提供统一的错误处理和日志记录功能
 */
import * as vscode from 'vscode';

// 错误类型枚举
export enum ErrorType {
    PARSE_ERROR = 'PARSE_ERROR',
    FILE_NOT_FOUND = 'FILE_NOT_FOUND',
    INVALID_POSITION = 'INVALID_POSITION',
    CACHE_ERROR = 'CACHE_ERROR',
    NETWORK_ERROR = 'NETWORK_ERROR',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

// 错误信息接口
export interface ErrorInfo {
    type: ErrorType;
    message: string;
    details?: string;
    file?: string;
    line?: number;
    column?: number;
    timestamp: number;
}

// 错误处理配置
const ERROR_CONFIG = {
    // 是否显示错误通知
    SHOW_NOTIFICATIONS: true,
    
    // 是否记录详细日志
    LOG_DETAILS: true,
    
    // 错误消息模板
    MESSAGES: {
        [ErrorType.PARSE_ERROR]: '解析文件时出错',
        [ErrorType.FILE_NOT_FOUND]: '文件未找到',
        [ErrorType.INVALID_POSITION]: '无效的位置',
        [ErrorType.CACHE_ERROR]: '缓存操作失败',
        [ErrorType.NETWORK_ERROR]: '网络请求失败',
        [ErrorType.UNKNOWN_ERROR]: '未知错误'
    } as const
} as const;

/**
 * 错误处理器类
 */
export class ErrorHandler {
    private static instance: ErrorHandler;
    private errorLog: ErrorInfo[] = [];
    private maxLogSize = 100;

    private constructor() {}

    /**
     * 获取单例实例
     */
    public static getInstance(): ErrorHandler {
        if (!ErrorHandler.instance) {
            ErrorHandler.instance = new ErrorHandler();
        }
        return ErrorHandler.instance;
    }

    /**
     * 处理错误
     */
    public handleError(
        error: Error | string,
        type: ErrorType = ErrorType.UNKNOWN_ERROR,
        context?: {
            file?: string;
            line?: number;
            column?: number;
            details?: string;
        }
    ): void {
        const errorInfo: ErrorInfo = {
            type,
            message: typeof error === 'string' ? error : error.message,
            details: context?.details || (error instanceof Error ? error.stack : undefined),
            file: context?.file,
            line: context?.line,
            column: context?.column,
            timestamp: Date.now()
        };

        // 记录错误
        this.logError(errorInfo);

        // 显示用户通知
        if (ERROR_CONFIG.SHOW_NOTIFICATIONS) {
            this.showUserNotification(errorInfo);
        }
    }

    /**
     * 记录错误到日志
     */
    private logError(errorInfo: ErrorInfo): void {
        // 添加到内存日志
        this.errorLog.push(errorInfo);
        
        // 限制日志大小
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog = this.errorLog.slice(-this.maxLogSize);
        }

        // 控制台日志
        const logMessage = this.formatLogMessage(errorInfo);
        console.error(logMessage);

        if (ERROR_CONFIG.LOG_DETAILS && errorInfo.details) {
            console.error('[Error Details]:', errorInfo.details);
        }
    }

    /**
     * 显示用户通知
     */
    private showUserNotification(errorInfo: ErrorInfo): void {
        const message = ERROR_CONFIG.MESSAGES[errorInfo.type] || errorInfo.message;
        
        // 根据错误类型选择通知类型
        switch (errorInfo.type) {
            case ErrorType.FILE_NOT_FOUND:
            case ErrorType.INVALID_POSITION:
                vscode.window.showWarningMessage(message);
                break;
            case ErrorType.PARSE_ERROR:
            case ErrorType.CACHE_ERROR:
            case ErrorType.NETWORK_ERROR:
            case ErrorType.UNKNOWN_ERROR:
            default:
                vscode.window.showErrorMessage(message);
                break;
        }
    }

    /**
     * 格式化日志消息
     */
    private formatLogMessage(errorInfo: ErrorInfo): string {
        const parts = [
            `[${errorInfo.type}]`,
            errorInfo.message
        ];

        if (errorInfo.file) {
            parts.push(`文件: ${errorInfo.file}`);
        }

        if (errorInfo.line !== undefined) {
            parts.push(`行: ${errorInfo.line + 1}`);
        }

        if (errorInfo.column !== undefined) {
            parts.push(`列: ${errorInfo.column + 1}`);
        }

        return parts.join(' | ');
    }

    /**
     * 获取错误日志
     */
    public getErrorLog(): ErrorInfo[] {
        return [...this.errorLog];
    }

    /**
     * 清空错误日志
     */
    public clearErrorLog(): void {
        this.errorLog = [];
    }

    /**
     * 获取特定类型的错误
     */
    public getErrorsByType(type: ErrorType): ErrorInfo[] {
        return this.errorLog.filter(error => error.type === type);
    }

    /**
     * 获取最近的错误
     */
    public getRecentErrors(count: number = 10): ErrorInfo[] {
        return this.errorLog.slice(-count);
    }
}

/**
 * 便捷的错误处理函数
 */
export const errorHandler = ErrorHandler.getInstance();

/**
 * 安全执行函数，自动处理错误
 */
export async function safeExecute<T>(
    fn: () => Promise<T> | T,
    errorType: ErrorType = ErrorType.UNKNOWN_ERROR,
    context?: {
        file?: string;
        line?: number;
        column?: number;
        details?: string;
    }
): Promise<T | null> {
    try {
        return await fn();
    } catch (error) {
        errorHandler.handleError(
            error instanceof Error ? error : String(error),
            errorType,
            context
        );
        return null;
    }
}

/**
 * 解析错误处理
 */
export function handleParseError(
    error: Error,
    file?: string,
    line?: number,
    column?: number
): void {
    errorHandler.handleError(error, ErrorType.PARSE_ERROR, {
        file,
        line,
        column,
        details: `解析文件时发生错误: ${error.message}`
    });
}

/**
 * 文件未找到错误处理
 */
export function handleFileNotFoundError(
    filePath: string,
    context?: string
): void {
    errorHandler.handleError(
        `文件未找到: ${filePath}`,
        ErrorType.FILE_NOT_FOUND,
        {
            file: filePath,
            details: context
        }
    );
}

/**
 * 位置错误处理
 */
export function handleInvalidPositionError(
    position: { line: number; column: number },
    file?: string
): void {
    errorHandler.handleError(
        `无效的位置: 行 ${position.line + 1}, 列 ${position.column + 1}`,
        ErrorType.INVALID_POSITION,
        {
            file,
            line: position.line,
            column: position.column
        }
    );
}

/**
 * 缓存错误处理
 */
export function handleCacheError(
    error: Error,
    operation: string
): void {
    errorHandler.handleError(error, ErrorType.CACHE_ERROR, {
        details: `缓存操作失败 (${operation}): ${error.message}`
    });
} 
