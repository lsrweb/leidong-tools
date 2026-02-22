/**
 * ColorProvider - 智能 Color Picker
 * 在 HTML/CSS 中检测颜色值，提供内联颜色块预览和颜色选择器
 * 支持 hex (#fff, #ffffff, #ffffffff), rgb/rgba, hsl/hsla, 命名颜色
 */
import * as vscode from 'vscode';

// CSS 命名颜色 → hex
const NAMED_COLORS: Record<string, string> = {
    'red': '#ff0000', 'blue': '#0000ff', 'green': '#008000', 'white': '#ffffff',
    'black': '#000000', 'yellow': '#ffff00', 'orange': '#ffa500', 'purple': '#800080',
    'pink': '#ffc0cb', 'gray': '#808080', 'grey': '#808080', 'cyan': '#00ffff',
    'magenta': '#ff00ff', 'lime': '#00ff00', 'navy': '#000080', 'teal': '#008080',
    'maroon': '#800000', 'olive': '#808000', 'aqua': '#00ffff', 'silver': '#c0c0c0',
    'gold': '#ffd700', 'coral': '#ff7f50', 'tomato': '#ff6347', 'salmon': '#fa8072',
    'chocolate': '#d2691e', 'firebrick': '#b22222', 'indianred': '#cd5c5c',
    'darkblue': '#00008b', 'darkgreen': '#006400', 'darkred': '#8b0000',
    'lightblue': '#add8e6', 'lightgreen': '#90ee90', 'lightgray': '#d3d3d3',
    'lightgrey': '#d3d3d3', 'darkgray': '#a9a9a9', 'darkgrey': '#a9a9a9',
    'whitesmoke': '#f5f5f5', 'transparent': '#00000000',
    'skyblue': '#87ceeb', 'steelblue': '#4682b4', 'royalblue': '#4169e1',
    'dodgerblue': '#1e90ff', 'deepskyblue': '#00bfff', 'cornflowerblue': '#6495ed',
    'cadetblue': '#5f9ea0', 'midnightblue': '#191970', 'slateblue': '#6a5acd',
};

function hexToColor(hex: string): vscode.Color | null {
    hex = hex.replace('#', '');
    let r: number, g: number, b: number, a = 1;
    if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16) / 255;
        g = parseInt(hex[1] + hex[1], 16) / 255;
        b = parseInt(hex[2] + hex[2], 16) / 255;
    } else if (hex.length === 6) {
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
    } else if (hex.length === 8) {
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
        a = parseInt(hex.substring(6, 8), 16) / 255;
    } else {
        return null;
    }
    if (isNaN(r) || isNaN(g) || isNaN(b)) { return null; }
    return new vscode.Color(r, g, b, a);
}

function colorToHex(color: vscode.Color): string {
    const r = Math.round(color.red * 255).toString(16).padStart(2, '0');
    const g = Math.round(color.green * 255).toString(16).padStart(2, '0');
    const b = Math.round(color.blue * 255).toString(16).padStart(2, '0');
    if (color.alpha < 1) {
        const a = Math.round(color.alpha * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}${a}`;
    }
    return `#${r}${g}${b}`;
}

function rgbToColor(r: number, g: number, b: number, a?: number): vscode.Color {
    return new vscode.Color(
        Math.min(255, Math.max(0, r)) / 255,
        Math.min(255, Math.max(0, g)) / 255,
        Math.min(255, Math.max(0, b)) / 255,
        a !== undefined ? Math.min(1, Math.max(0, a)) : 1
    );
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    h = h / 360; s = s / 100; l = l / 100;
    let r: number, g: number, b: number;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p: number, q: number, t: number) => {
            if (t < 0) { t += 1; }
            if (t > 1) { t -= 1; }
            if (t < 1 / 6) { return p + (q - p) * 6 * t; }
            if (t < 1 / 2) { return q; }
            if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export class VueColorProvider implements vscode.DocumentColorProvider {

    provideDocumentColors(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.ColorInformation[] {
        const config = vscode.workspace.getConfiguration('leidong-tools');
        if (!config.get<boolean>('enableColorPicker', false)) {
            return [];
        }

        const text = document.getText();
        const colors: vscode.ColorInformation[] = [];

        // Hex colors: #fff, #ffffff, #ffffffff
        const hexRegex = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
        let match: RegExpExecArray | null;
        while ((match = hexRegex.exec(text)) !== null) {
            const color = hexToColor(match[0]);
            if (color) {
                const pos = document.positionAt(match.index);
                const range = new vscode.Range(pos, document.positionAt(match.index + match[0].length));
                colors.push(new vscode.ColorInformation(range, color));
            }
        }

        // rgb(r, g, b) / rgba(r, g, b, a)
        const rgbRegex = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)/g;
        while ((match = rgbRegex.exec(text)) !== null) {
            const r = parseInt(match[1]); const g = parseInt(match[2]); const b = parseInt(match[3]);
            const a = match[4] !== undefined ? parseFloat(match[4]) : undefined;
            const color = rgbToColor(r, g, b, a);
            const pos = document.positionAt(match.index);
            const range = new vscode.Range(pos, document.positionAt(match.index + match[0].length));
            colors.push(new vscode.ColorInformation(range, color));
        }

        // hsl(h, s%, l%) / hsla(h, s%, l%, a)
        const hslRegex = /hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%?\s*,\s*(\d{1,3})%?(?:\s*,\s*([\d.]+))?\s*\)/g;
        while ((match = hslRegex.exec(text)) !== null) {
            const h = parseInt(match[1]); const s = parseInt(match[2]); const l = parseInt(match[3]);
            const a = match[4] !== undefined ? parseFloat(match[4]) : undefined;
            const [r, g, b] = hslToRgb(h, s, l);
            const color = rgbToColor(r, g, b, a);
            const pos = document.positionAt(match.index);
            const range = new vscode.Range(pos, document.positionAt(match.index + match[0].length));
            colors.push(new vscode.ColorInformation(range, color));
        }

        // 命名颜色 (只在 style 属性或 CSS 上下文中)
        if (document.languageId === 'css' || document.languageId === 'html') {
            for (const [name, hex] of Object.entries(NAMED_COLORS)) {
                const namedRegex = new RegExp(`(?<=[:;,\\s])\\b${name}\\b(?=[;,\\s}!])`, 'gi');
                while ((match = namedRegex.exec(text)) !== null) {
                    const color = hexToColor(hex);
                    if (color) {
                        const pos = document.positionAt(match.index);
                        const range = new vscode.Range(pos, document.positionAt(match.index + match[0].length));
                        colors.push(new vscode.ColorInformation(range, color));
                    }
                }
            }
        }

        return colors;
    }

    provideColorPresentations(
        color: vscode.Color,
        context: { document: vscode.TextDocument; range: vscode.Range },
        _token: vscode.CancellationToken
    ): vscode.ColorPresentation[] {
        const presentations: vscode.ColorPresentation[] = [];
        const r = Math.round(color.red * 255);
        const g = Math.round(color.green * 255);
        const b = Math.round(color.blue * 255);
        const a = color.alpha;

        // Hex
        presentations.push(new vscode.ColorPresentation(colorToHex(color)));

        // RGB / RGBA
        if (a < 1) {
            presentations.push(new vscode.ColorPresentation(`rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`));
        } else {
            presentations.push(new vscode.ColorPresentation(`rgb(${r}, ${g}, ${b})`));
        }

        return presentations;
    }
}
