import { getContext } from '../../../extensions.js';

// Matches a message that is ONLY this tool call, with curly braces around GenerateImage.
const PATTERN = /^\s*<tool_call>\s*\{GenerateImage\}\s*<arg_key>\s*prompt\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>\s*<\/tool_call>\s*$/;

// Prevents running the same message twice (e.g. on re-render).
const handled = new Set();

async function onMessageReceived(messageId) {
    const { chat, executeSlashCommandsWithOptions } = getContext();
    const message = chat[messageId];

    if (!message || message.is_user) return;

    const match = PATTERN.exec(message.mes ?? '');
    if (!match) return;

    const key = `${messageId}:${message.mes}`;
    if (handled.has(key)) return;
    handled.add(key);

    // "|" and newlines are special in slash command arguments, so flatten them.
    const prompt = match[1].replace(/[\r\n|]+/g, ', ').trim();
    if (!prompt) return;

    await executeSlashCommandsWithOptions(`/sd ${prompt}`);
    await executeSlashCommandsWithOptions(`/hide ${messageId}`);
}

jQuery(async () => {
    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
});
