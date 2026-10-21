const TAG = '[st-hide-tool-images]';
const PLACEHOLDER = 'Image generated and already shown to the user.';
const GENERATE_URL = '/api/backends/chat-completions/generate';

// Name of the image-generation function (matched against tool_calls[].function.name).
// Edit this if your tool is called something else.
const IMAGE_TOOL_NAME_RE = /generate.?image/i;

// Text that replaces an older image tool exchange in the prompt.
// {{char}} = character name, {{prompt}} = the image prompt the model used.
const NOTE_TEMPLATE = '[{{char}} sent a picture that contains: {{prompt}}]';

// Keep only the newest N note-only messages in the prompt. 0 = keep all.
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

// Failed call of the image tool, e.g. 'Error: No tool with the name "GenerateImage" has been registered.'
function isFailedResult(msg) {
    return isToolRole(msg) && typeof msg.content === 'string' && /^error\b/i.test(msg.content.trim());
}

function hasText(content) {
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return false;
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
 * Trims image-generation tool exchanges from the prompt:
 *  - the newest successful image call stays as a real tool call (so the model keeps
 *    the tool-call format), with its result masked to a placeholder
 *  - older successful image calls are removed (tool result + tool_calls entry) and
 *    replaced by a text note "[{{char}} sent a picture that contains: {{prompt}}]"
 *  - failed image calls are removed with no note
 *  - other function calls are never touched
 *  - a tool result at the end of the prompt (call in flight) is masked, not removed
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

    // 'sent'   = picture was sent (image path, or empty/'undefined' result of the image tool)
    // 'failed' = the image tool call errored (nothing was sent)
    const kindOf = (msg) => {
        if (!isToolRole(msg)) return null;
        if (isImagePathResult(msg)) return 'sent';
        const name = callById.get(msg.tool_call_id)?.function?.name || msg.name || '';
        if (!IMAGE_TOOL_NAME_RE.test(name)) return null;
        if (isEmptyResult(msg)) return 'sent';
        if (isFailedResult(msg)) return 'failed';
        return null;
    };

    // Trailing run of tool messages = in-flight results.
    let tailStart = messages.length;
    while (tailStart > 0 && isToolRole(messages[tailStart - 1])) tailStart--;

    // Newest successful image call is kept as a real example of tool calling.
    let keepIdx = -1;
    messages.forEach((msg, i) => {
        if (kindOf(msg) === 'sent') keepIdx = i;
    });

    const removedIds = new Set();
    const failedIds = new Set();
    const dropIdx = new Set();
    let replaced = 0;

    messages.forEach((msg, i) => {
        const kind = kindOf(msg);
        if (!kind) return;

        if (i >= tailStart || i === keepIdx) {
            if (kind === 'sent') {
                msg.content = PLACEHOLDER;
                replaced++;
            }
            return;
        }

        dropIdx.add(i);
        if (msg.tool_call_id) {
            removedIds.add(msg.tool_call_id);
            if (kind === 'failed') failedIds.add(msg.tool_call_id);
        }
    });

    if (dropIdx.size === 0 && replaced === 0) return { messages, removed: 0, replaced: 0 };

    const charName = getCharName();
    const result = [];
    const pureNotes = new Set(); // assistant messages that now contain only a picture note

    messages.forEach((msg, i) => {
        if (dropIdx.has(i)) return;

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && removedIds.size > 0) {
            const removedCalls = msg.tool_calls.filter(tc => removedIds.has(tc?.id));
            if (removedCalls.length > 0) {
                const kept = msg.tool_calls.filter(tc => !removedIds.has(tc?.id));

                // Failed calls get no note: nothing was sent.
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
                    return; // only a failed call was in this message: drop it
                }
            }
        }

        result.push(msg);
    });

    // Keep only the newest note-only messages.
    let final = result;
    if (MAX_NOTES_IN_HISTORY > 0) {
        const pure = result.filter(m => pureNotes.has(m));
        const drop = new Set(pure.slice(0, Math.max(0, pure.length - MAX_NOTES_IN_HISTORY)));
        if (drop.size > 0) final = result.filter(m => !drop.has(m));
    }

    return { messages: final, removed: dropIdx.size, replaced };
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
                        console.log(`${TAG} removed ${removed} older image exchange(s), kept newest as tool call, masked ${replaced}.`);
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
