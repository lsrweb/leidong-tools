import { getChatModels } from '../../models';

export const REPLAY_MARKER_MIME = 'stateful_marker';
export const REPLAY_MARKER_WRITER_ID = 'deepseek-copilot';

/**
 * Marker prefixes: the writer id plus every configured model id.
 * Lazy because the model registry is settings-driven at runtime.
 */
export function getReplayMarkerPrefixes(): Set<string> {
	return new Set([
		REPLAY_MARKER_WRITER_ID,
		...getChatModels().map((model) => model.id),
	]);
}
export const ENCODED_JSON_MARKER_PREFIX = 'json:';
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
export const LEGACY_SEGMENT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
