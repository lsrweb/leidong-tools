/**
 * 扩展核心配置
 */

// 扩展配置常量
export const EXTENSION_CONFIG = {
    // 扩展名称
    NAME: 'leidong-tools',
    
    // 命令前缀
    COMMAND_PREFIX: 'leidong-tools',
    
    // 缓存配置
    CACHE: {
        VALIDITY_PERIOD: 30 * 1000, // 30秒
    },
    
    // 日志相关
    LOG: {
        TYPES: ['log', 'error', 'info', 'debug'] as const,
        ICONS: {
            log: '🔥',
            error: '❌',
            info: 'ℹ️',
            debug: '🐛'
        }
    },
    
    // 补全相关
    COMPLETION: {
        SORT_TEXT: '0000', // 高优先级排序
        IDENTIFIER: '(雷动三千)'
    },
    
    // 支持的文件类型
    SUPPORTED_LANGUAGES: {
        JAVASCRIPT: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'html'],
        COMPLETION_PATTERNS: ['**/*.dev.js'],
        ALL_FILES: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'html', 'css', 'json', 'markdown', 'plaintext']
    },
    
    // Von 功能配置
    VON: {
        TRIGGER_TEXT: 'von',
        TIME_FORMAT: 'YYYYMMDDHHMMSS'
    }
} as const;

// 命令名称映射
export const COMMANDS = {
    GO_TO_DEFINITION_NEW_TAB: `${EXTENSION_CONFIG.COMMAND_PREFIX}.goToDefinitionInNewTab`,
    LOG_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.logVariable`,
    ERROR_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.errorVariable`,
    INFO_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.infoVariable`,
    DEBUG_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.debugVariable`,
    QUICK_LOG_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.quickLogVariable`,
    QUICK_ERROR_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.quickErrorVariable`,
    QUICK_INFO_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.quickInfoVariable`,
    QUICK_DEBUG_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.quickDebugVariable`,
    COMPRESS_LINES: `${EXTENSION_CONFIG.COMMAND_PREFIX}.compressLines`,
    QUICK_CONSOLE_LOG: `${EXTENSION_CONFIG.COMMAND_PREFIX}.quickConsoleLog`,
    QUICK_CONSOLE_ERROR: `${EXTENSION_CONFIG.COMMAND_PREFIX}.quickConsoleError`,
    LOG_SELECTED_VARIABLE: `${EXTENSION_CONFIG.COMMAND_PREFIX}.logSelectedVariable`,
    ADD_VARIABLE_COMMENT: `${EXTENSION_CONFIG.COMMAND_PREFIX}.addVariableComment`
} as const;

// 文件选择器配置
export const FILE_SELECTORS = {
    // 支持所有前端开发文件类型的日志补全
    JAVASCRIPT: [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'javascriptreact' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'html' },
        { scheme: 'file', pattern: '**/*.dev.js' }
    ],
    JAVASCRIPT_ONLY: [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'javascriptreact' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', pattern: '**/*.dev.js' }
    ],
    HTML: [
        { scheme: 'file', language: 'html' }
    ]
} as const;
