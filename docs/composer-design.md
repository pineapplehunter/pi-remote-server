# Composer design references

Request: improve the chat input using existing chat UIs as references, and send with Ctrl+Enter.

## Research

- [LibreChat ChatForm](https://github.com/danny-avila/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/client/src/components/Chat/Input/ChatForm.tsx), inspected from a shallow checkout at `f10b1d9`: a rounded surface enclosing an auto-sizing textarea and a separate bottom action row. Focus is shown on the whole surface; the field starts small and scrolls when capped.
- [LibreChat keyboard handling](https://github.com/danny-avila/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/client/src/hooks/Input/useTextarea.ts): composition-aware keyboard handling, including the Safari key-code 229 case; resizing after text changes.
- [assistant-ui Composer](https://www.assistant-ui.com/elements/composer) and [Composer primitives](https://www.assistant-ui.com/docs/primitives/composer): a growing field above a toolbar/send action; `ctrlEnter` is an explicit submission mode. Send availability follows whether the composer can send.

These are design/interaction references, not vendored source or new framework dependencies.

## Adaptation for Pi

Keep the existing quiet developer-console palette: light canvas `#f6f8fb`, white surface, ink `#192a40`, muted `#53657b`, boundary `#cbd4df`, blue action `#215d9c`; use the existing dark-theme equivalents. Keep the system typeface and chat layout rather than redesigning the entire application.

```text
╭───────────────────────────────────────────────────╮
│ Ask Pi to investigate, explain, or make a change…  │
│ A multiline field that grows with your draft      │
│                                                   │
│ Ctrl + Enter to send   Enter for a new line  Send ↑│
╰───────────────────────────────────────────────────╯
```

Left-align text. Put the Send action at the bottom right, with an accessible label and 44px minimum touch target. Give the enclosing surface a focus outline. Grow/shrink the field on edits, paste, send and routing-error restoration; cap height to 224px or 30% of viewport so the conversation remains visible. Keep newline input native. Ctrl+Enter uses the existing form submission path; ignore repeat and composition events. Disable Send for blank/offline input but leave the draft editable.

Do not copy attachment, model-picker, voice or stop controls: this protocol supports none of them. Do not block follow-ups just because Pi is busy. Preserve literal whitespace, Pi user echoes, and the existing no-delivery-guarantee/error behavior.

The separate header toggle hides only tool rows. Its browser-local preference survives view swaps/reloads when localStorage is available; activity updates and gateway history continue normally. It stores no conversation data.
