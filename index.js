const TAG = '[st-hide-tool-images]';
const PLACEHOLDER = 'Image generated and already shown to the user.';
const GENERATE_URL = '/api/backends/chat-completions/generate';

// Name of the image-generation function (matched against tool_calls[].function.name).
const IMAGE_TOOL_NAME_RE = /generate.?image/i;

// Text that replaces a removed image tool exchange in the prompt.
const NOTE_TEMPLATE = '[{{char}} sent a picture that contains: {{prompt}}]';

// Keep only the newest N picture notes in the prompt; older note-only messages are dropped.
const MAX_NOTES_IN_HISTORY = 1;

// Log the role sequence of every chat request to the browser console (for debugging).
const DEBUG = false;

const isToolRole = (msg) => msg && (msg.role === 'tool' || msg.role === 'function');

// Bare image path, e.g. /user/images/Priya/Priya_2026-10-19@20h45m22s972ms.webp
function isImagePathResult(msg) {
    if (!isToolRole(msg) || typeof msg.content !== 'string') return false;
    return /^\/user\/images\/.+\.(webp|png|jpe?g)$/i.test(msg.content.trim());
}

// Empty / failed result of the image tool, e.g. content: 'undefined'
function isEmptyResult(msg) {
    if (!isToolRole(msg)) return false;
    if (msg.content === undefined || msg.content === null) return true;
    if (typeof msg.content !== 'string') return false;
    return ['', 'undefined', 'null'].includes(msg.content.trim());
}

// Failed call of the image tool
function isFailedResult(msg) {
    return isToolRole(msg) && typeof msg.content === 'string' && /^error\b/i.test(msg.content.trim());
}

function getCharName() {
    try {
        return SillyTavern.getContext().name2 || 'Character';
    } catch {
        return 'Character';
    }
}

// Pull the image prompt out of a tool call's arguments.
function extractPrompt(tc) {
    let args = tc?.function?.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return args.trim(); }
    }
    if (args && typeof args === 'object') {
        const v = args.prompt ?? args.description ?? args.text ??
            Object.values(args).find(x => typeof x === 'string');
        return typeof v === 'string' ? v.trim() : '';
    }
    return '';
}

function buildNote(prompt, charName) {
    return NOTE_TEMPLATE
        .replaceAll('{{char}}', charName)
        .replaceAll('{{prompt}}', prompt || 'an image');
}

function hasText(content) {
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return false;
}

function appendText(content, text) {
    if (Array.isArray(content)) return [...content, { type: 'text', text }];
    if (typeof content === 'string' && content.trim()) return `${content}\n${text}`;
    return text;
}

/**
 * Keeps ONLY the absolute newest image tool response in the entire history.
 * All older tool responses are stripped and converted into text notes.
 */
function stripImageToolExchanges(messages) {
    const callById = new Map();
    for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
                if (tc?.id) callById.set(tc.id, tc);
            }
        }
    }

    const kindOf = (msg) => {
        if (!isToolRole(msg)) return null;
        if (isImagePathResult(msg)) return 'sent';
        const name = callById.get(msg.tool_call_id)?.function?.name || msg.name || '';
        if (!IMAGE_TOOL_NAME_RE.test(name)) return null;
        if (isEmptyResult(msg)) return 'sent';
        if (isFailedResult(msg)) return 'failed';
        return null;
    };

    // Find ALL image tool messages across the entire history
    const imageToolItems = [];
    messages.forEach((msg, i) => {
        const kind = kindOf(msg);
        if (kind) {
            imageToolItems.push({ index: i, msg, kind, tool_call_id: msg.tool_call_id });
        }
    });

    if (imageToolItems.length === 0) return { messages, removed: 0, replaced: 0 };

    const dropIndices = new Set();
    const removedIds = new Set();
    const failedIds = new Set();

    // Keep the absolute LAST item; drop/convert all previous ones into notes
    const lastItem = imageToolItems[imageToolItems.length - 1];
    for (let j = 0; j < imageToolItems.length - 1; j++) {
        const item = imageToolItems[j];
        dropIndices.add(item.index);
        if (item.tool_call_id) {
            removedIds.add(item.tool_call_id);
            if (item.kind === 'failed') failedIds.add(item.tool_call_id);
        }
    }

    // Check if the last item is in-flight (at the tail)
    let tailStart = messages.length;
    while (tailStart > 0 && isToolRole(messages[tailStart - 1])) tailStart--;

    let replaced = 0;
    if (lastItem.index >= tailStart) {
        if (lastItem.kind === 'sent') {
            lastItem.msg.content = PLACEHOLDER;
            replaced++;
        }
    }

    if (dropIndices.size === 0 && replaced === 0) return { messages, removed: 0, replaced: 0 };

    const charName = getCharName();
    const result = [];
    const pureNotes = new Set();

    messages.forEach((msg, i) => {
        if (dropIndices.has(i)) return;

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && removedIds.size > 0) {
            const removedCalls = msg.tool_calls.filter(tc => removedIds.has(tc?.id));
            if (removedCalls.length > 0) {
                const kept = msg.tool_calls.filter(tc => !removedIds.has(tc?.id));
                const notes = removedCalls
                    .filter(tc => !failedIds.has(tc.id))
                    .map(tc => buildNote(extractPrompt(tc), charName))
                    .join('\n');

                const hadText = hasText(msg.content);
                if (kept.length > 0) msg.tool_calls = kept;
                else delete msg.tool_calls;

                if (notes) {
                    msg.content = appendText(msg.content, notes);
                    if (!hadText && kept.length === 0) pureNotes.add(msg);
                } else if (!hadText && kept.length === 0) {
                    return;
                }
            }
        }

        result.push(msg);
    });

    // Drop the oldest note-only messages beyond the cap.
    let final = result;
    if (MAX_NOTES_IN_HISTORY > 0) {
        const pure = result.filter(m => pureNotes.has(m));
        const drop = new Set(pure.slice(0, Math.max(0, pure.length - MAX_NOTES_IN_HISTORY)));
        if (drop.size > 0) final = result.filter(m => !drop.has(m));
    }

    return { messages: final, removed: dropIndices.size, replaced };
}

(function attachFetchInterceptor() {
    const originalFetch = window.fetch;

    window.fetch = async function (resource, init) {
        try {
            const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';

            if (url.includes(GENERATE_URL) && init && typeof init.body === 'string') {
                const body = JSON.parse(init.body);

                if (body && Array.isArray(body.messages)) {
                    if (DEBUG) console.log(TAG, 'roles in:', body.messages.map(m => m.role + (m.tool_calls ? '(tc)' : '')).join(' '));
                    const { messages, removed, replaced } = stripImageToolExchanges(body.messages);
                    if (DEBUG) console.log(TAG, 'roles out:', messages.map(m => m.role + (m.tool_calls ? '(tc)' : '')).join(' '));

                    if (removed > 0 || replaced > 0) {
                        body.messages = messages;
                        init = { ...init, body: JSON.stringify(body) };
                        console.log(`${TAG} converted ${removed} older image tool exchange(s) to text notes, keeping only the latest one.`);
                    }
                }
            }
        } catch (err) {
            console.error(TAG, 'Error in fetch interceptor:', err);
        }

        return originalFetch.call(this, resource, init);
    };
})();

console.log(`${TAG} Extension loaded and fetch interceptor active.`);
