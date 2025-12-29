function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function inferObjectProperties(text: string, root: string): string[] {
    if (!root) { return []; }
    const props = new Set<string>();
    const escapedRoot = escapeRegExp(root);
    const dotAccess = new RegExp(
        `(?:\\b(?:this|that)\\s*\\.\\s*)?\\b${escapedRoot}\\s*(?:\\?\\.|\\.)\\s*([a-zA-Z_$][\\w$]*)`,
        'g'
    );
    const bracketAccess = new RegExp(
        `(?:\\b(?:this|that)\\s*\\.\\s*)?\\b${escapedRoot}\\s*(?:\\?\\.)?\\s*\\[\\s*(['"])([^'"]+)\\1\\s*\\]`,
        'g'
    );
    let match: RegExpExecArray | null;
    while ((match = dotAccess.exec(text)) !== null) {
        props.add(match[1]);
    }
    while ((match = bracketAccess.exec(text)) !== null) {
        props.add(match[2]);
    }
    return Array.from(props.values());
}
