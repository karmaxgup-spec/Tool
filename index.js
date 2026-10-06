// Tool Call Image: detects text-format GenerateImage tool calls in AI replies,
// removes them from the message, and runs /sd with the prompt.

(function () {
    const ctx = () => SillyTavern.getContext();

    // Matches <tool_call>{GenerateImage}<arg_key>..</arg_key><arg_value>..</arg_value></tool_call>
    // Braces around the name are optional.
    const TOOL_CALL_RE = /<tool_call>\s*\{?\s*(\w+)\s*\}?\s*([\s\S]*?)<\/tool_call>/gi;
    const ARG_RE = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;

    let queue = Promise.resolve();

    function extractCalls(text) {
        const calls = [];
        for (const m of text.matchAll(TOOL_CALL_RE)) {
            const name = m[1];
            if (name.toLowerCase() !== 'generateimage') continue;
            let prompt = null;
            for (const a of m[2].matchAll(ARG_RE)) {
                if (a[1].trim().toLowerCase() === 'prompt') prompt = a[2].trim();
            }
            if (prompt) calls.push(prompt);
        }
        return calls;
    }

    function escapeForSlash(prompt) {
        return prompt
            .replace(/\r?\n/g, ' ')
            .replace(/\|/g, '\\|')
            .replace(/\{\{/g, '{ {')
            .replace(/\}\}/g, '} }');
    }

    async function handleMessage(messageId) {
        const c = ctx();
        const message = c.chat[messageId];
        if (!message || message.is_user || message.is_system) return;
        if (typeof message.mes !== 'string' || !/<tool_call>/i.test(message.mes)) return;

        const prompts = extractCalls(message.mes);
        if (!prompts.length) return;

        // Remove the tool call text from the message
        let cleaned = message.mes.replace(TOOL_CALL_RE, (full, name) =>
            name.toLowerCase() === 'generateimage' ? '' : full,
        ).trim();
        if (!cleaned) cleaned = '📷';
        message.mes = cleaned;
        c.updateMessageBlock(messageId, message);
        await c.saveChat();

        // Run /sd for each prompt, one at a time
        for (const prompt of prompts) {
            queue = queue.then(async () => {
                try {
                    await c.executeSlashCommandsWithOptions(`/sd ${escapeForSlash(prompt)}`);
                } catch (err) {
                    console.error('[Tool Call Image] /sd failed', err);
                    toastr.error('Image generation failed. Check console.');
                }
            });
        }
        await queue;
    }

    function init() {
        const c = ctx();
        c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, (id) => handleMessage(id));
        console.log('[Tool Call Image] loaded');
    }

    if (window.SillyTavern?.getContext) init();
    else window.addEventListener('load', init);
})();
