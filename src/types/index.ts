/**
 * 扩展使用的类型定义
 */
import * as vscode from 'vscode';

// 解析结果接口
export interface ParseResult {
    variables: vscode.CompletionItem[];
    methods: vscode.CompletionItem[];
    timestamp: number;
    thisReferences: Map<string, vscode.CompletionItem>;
}

// 日志类型
export type LogType = 'log' | 'error' | 'info' | 'debug';

// 缓存项接口
export interface CacheItem {
    variables: vscode.CompletionItem[];
    methods: vscode.CompletionItem[];
    timestamp: number;
    thisReferences: Map<string, vscode.CompletionItem>;
}

// Vue 定义查找结果
export interface VueDefinitionResult {
    location: vscode.Location | null;
    found: boolean;
}
