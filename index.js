Const TAG = '[st-hide-tool-images]';
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
    If (!isToolRole(msg) || typeof msg.content !== 'string') return false;
    Return /^\/user\/images\/.+\.(webp|png|jpe?g)$/i.test(msg.content.trim());
}

// Empty / failed result of the image tool, e.g. content: 'undefined'
function isEmptyResult(msg) {
    If (!isToolRole(msg)) return false;
    If (msg.content === undefined || msg.content === null) return true;
    If (typeof msg.content !== 'string') return false;
    Return ['', 'undefined', 'null'].includes(msg.content.trim());
}

// Failed call of the image tool
function isFailedResult(msg) {
    Return isToolRole(msg) && typeof msg.content === 'string' && /^error\b/i.test(msg.content.trim());
}

function getCharName() {
    Try {
        Return SillyTavern.getContext().name2 || 'Character';
    } catch {
        Return 'Character';
    }
}

// Pull the image prompt out of a tool call's arguments.
function extractPrompt(tc) {
    Let args = tc?.function?.arguments;
    If (typeof args === 'string') {
        Try { args = JSON.parse(args); } catch { return args.trim(); }
    }
    If (args && typeof args === 'object') {
        Const v = args.prompt ?? args.description ?? args.text ??
            Object.values(args).find(x => typeof x === 'string');
        Return typeof v === 'string' ? v.trim() : '';
    }
    Return '';
}

function buildNote(prompt, charName) {
    Return NOTE_TEMPLATE
        .replaceAll('{{char}}', charName)
        .replaceAll('{{prompt}}', prompt || 'an image');
}

function hasText(content) {
    If (typeof content === 'string') return content.trim().length > 0;
    If (Array.isArray(content)) return content.length > 0;
    Return false;
}

function appendText(content, text) {
    If (Array.isArray(content)) return [...content, { type: 'text', text }];
    If (typeof content === 'string' && content.trim()) return `${content}\n${text}`;
    Return text;
}

/**
 * Replaces finished image-generation tool exchanges in history, 
 * but keeps the single most recent completed tool response intact.
 */
function stripImageToolExchanges(messages) {
    Const callById = new Map();
    For (const msg of messages) {
        If (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            For (const tc of msg.tool_calls) {
                If (tc?.id) callById.set(tc.id, tc);
            }
        }
    }

    Const kindOf = (msg) => {
        If (!isToolRole(msg)) return null;
        If (isImagePathResult(msg)) return 'sent';
        Const name = callById.get(msg.tool_call_id)?.function?.name || msg.name || '';
        If (!IMAGE_TOOL_NAME_RE.test(name)) return null;
        If (isEmptyResult(msg)) return 'sent';
        If (isFailedResult(msg)) return 'failed';
        Return null;
    };

    // Trailing run of tool messages = in-flight results.
    Let tailStart = messages.length;
    While (tailStart > 0 && isToolRole(messages[tailStart - 1])) tailStart--;

    // Collect all completed historical tool responses
    Const completedToolIndices = [];
    Messages.forEach((msg, i) => {
        Const kind = kindOf(msg);
        If (!kind) return;

        If (i >= tailStart) {
            // In flight: mask a result, but leave an error as is.
            If (kind === 'sent') {
                Msg.content = PLACEHOLDER;
            }
        } else {
            CompletedToolIndices.push({ index: i, msg, kind, tool_call_id: msg.tool_call_id });
        }
    });

    Const dropIdx = new Set();
    Const removedIds = new Set();
    Const failedIds = new Set();

    // If there are completed tool responses, keep the *very last* one, 
    // and drop/convert all older ones into text notes.
    If (completedToolIndices.length > 1) {
        For (let j = 0; j < completedToolIndices.length - 1; j++) {
            Const item = completedToolIndices[j];
            DropIdx.add(item.index);
            If (item.tool_call_id) {
                RemovedIds.add(item.tool_call_id);
                If (item.kind === 'failed') failedIds.add(item.tool_call_id);
            }
        }
    }

    If (dropIdx.size === 0) return { messages, removed: 0, replaced: 0 };

    Const charName = getCharName();
    Const result = [];
    Const pureNotes = new Set();

    Messages.forEach((msg, i) => {
        If (dropIdx.has(i)) return;

        If (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && removedIds.size > 0) {
            Const removedCalls = msg.tool_calls.filter(tc => removedIds.has(tc?.id));
            If (removedCalls.length > 0) {
                Const kept = msg.tool_calls.filter(tc => !removedIds.has(tc?.id));
                Const notes = removedCalls
                    .filter(tc => !failedIds.has(tc.id))
                    .map(tc => buildNote(extractPrompt(tc), charName))
                    .join('\n');

                Const hadText = hasText(msg.content);
                If (kept.length > 0) msg.tool_calls = kept;
                Else delete msg.tool_calls;

                If (notes) {
                    Msg.content = appendText(msg.content, notes);
                    If (!hadText && kept.length === 0) pureNotes.add(msg);
                } else if (!hadText && kept.length === 0) {
                    Return;
                }
            }
        }

        Result.push(msg);
    });

    // Drop the oldest note-only messages beyond the cap.
    Let final = result;
    If (MAX_NOTES_IN_HISTORY > 0) {
        Const pure = result.filter(m => pureNotes.has(m));
        Const drop = new Set(pure.slice(0, Math.max(0, pure.length - MAX_NOTES_IN_HISTORY)));
        If (drop.size > 0) final = result.filter(m => !drop.has(m));
    }

    Return { messages: final, removed: dropIdx.size, replaced: 0 };
}

(function attachFetchInterceptor() {
    Const originalFetch = window.fetch;

    Window.fetch = async function (resource, init) {
        Try {
            Const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';

            If (url.includes(GENERATE_URL) && init && typeof init.body === 'string') {
                Const body = JSON.parse(init.body);

                If (body && Array.isArray(body.messages)) {
                    If (DEBUG) console.log(TAG, 'roles in:', body.messages.map(m => m.role + (m.tool_calls ? '(tc)' : '')).join(' '));
                    Const { messages, removed, replaced } = stripImageToolExchanges(body.messages);
                    If (DEBUG) console.log(TAG, 'roles out:', messages.map(m => m.role + (m.tool_calls ? '(tc)' : '')).join(' '));

                    If (removed > 0 || replaced > 0) {
                        Body.messages = messages;
                        Init = { ...init, body: JSON.stringify(body) };
                        Console.log(`${TAG} converted ${removed} older image tool exchange(s) to text notes, keeping 1 recent tool response.`);
                    }
                }
            }
        } catch (err) {
            Console.error(TAG, 'Error in fetch interceptor:', err);
        }

        Return originalFetch.call(this, resource, init);
    };
})();

Console.log(`${TAG} Extension loaded and fetch interceptor active.`);
