const TAG = '[st-hide-tool-images]';
const PLACEHOLDER = 'Image generated and already shown to the user.';
const GENERATE_URL = '/api/backends/chat-completions/generate';

// Name of the image-generation function (matched against tool_calls[].function.name).
// Edit this if your tool is called something else.
const IMAGE_TOOL_NAME_RE = /generate.?image/i;

// Text that replaces a removed image tool exchange in the prompt.
// {{char}} = character name, {{prompt}} = the image prompt the model used.
const NOTE_TEMPLATE = '[{{char}} sent a picture that contains: {{prompt}}]';

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

function appendText(content, text) {
    if (Array.isArray(content)) return [...content, { type: 'text', text }];
    if (typeof content === 'string' && content.trim()) return `${content}\n${text}`;
    return text;
}

/**
 * Replaces finished image-generation tool exchanges in history:
 *  - the tool response message is removed
 *  - the matching tool_calls entry is removed (by id)
 *  - the assistant message gets "[{{char}} sent a picture that contains: {{prompt}}]" instead,
 *    so the model still knows what was sent
 * Other function calls are never touched. Tool results at the very end of the
 * prompt (call currently in flight) are kept, with the content swapped for a placeholder.
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

    const isUnwanted = (msg) => {
        if (isImagePathResult(msg)) return true;
        if (isEmptyResult(msg)) {
            const name = callById.get(msg.tool_call_id)?.function?.name || msg.name || '';
            return IMAGE_TOOL_NAME_RE.test(name);
        }
        return false;
    };

    // Trailing run of tool messages = in-flight results.
    let tailStart = messages.length;
    while (tailStart > 0 && isToolRole(messages[tailStart - 1])) tailStart--;

    const removedIds = new Set();
    const dropIdx = new Set();
    let replaced = 0;

    messages.forEach((msg, i) => {
        if (!isUnwanted(msg)) return;

        if (i >= tailStart) {
            msg.content = PLACEHOLDER;
            replaced++;
            return;
        }

        dropIdx.add(i);
        if (msg.tool_call_id) removedIds.add(msg.tool_call_id);
    });

    if (dropIdx.size === 0 && replaced === 0) return { messages, removed: 0, replaced: 0 };

    const charName = getCharName();
    const result = [];

    messages.forEach((msg, i) => {
        if (dropIdx.has(i)) return;

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && removedIds.size > 0) {
            const removedCalls = msg.tool_calls.filter(tc => removedIds.has(tc?.id));
            if (removedCalls.length > 0) {
                const kept = msg.tool_calls.filter(tc => !removedIds.has(tc?.id));
                const notes = removedCalls.map(tc => buildNote(extractPrompt(tc), charName)).join('\n');

                if (kept.length > 0) msg.tool_calls = kept;
                else delete msg.tool_calls;

                msg.content = appendText(msg.content, notes);
            }
        }

        result.push(msg);
    });

    return { messages: result, removed: dropIdx.size, replaced };
}

(function attachFetchInterceptor() {
    const originalFetch = window.fetch;

    window.fetch = async function (resource, init) {
        try {
            const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';

            if (url.includes(GENERATE_URL) && init && typeof init.body === 'string') {
                const body = JSON.parse(init.body);

                if (body && Array.isArray(body.messages)) {
                    const { messages, removed, replaced } = stripImageToolExchanges(body.messages);

                    if (removed > 0 || replaced > 0) {
                        body.messages = messages;
                        init = { ...init, body: JSON.stringify(body) };
                        console.log(`${TAG} replaced ${removed} image tool exchange(s) with a text note, masked ${replaced} in-flight.`);
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
