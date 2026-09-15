# OpenCode Anthropic OAuth

Unofficial Anthropic subscription OAuth for OpenCode V2.

> [!WARNING]
> Anthropic may restrict or suspend subscription accounts that use unofficial clients. Use this plugin at your own risk.

## Compatibility

This release targets OpenCode 2.0.3:

| Component | Version |
| --- | --- |
| OpenCode V2 | `2.0.3` |
| This plugin | `2.0.3` |
| `@opencode/plugin` | `2.0.3` |
| Effect | `4.0.0-rc.112` |

Run the development checks before updating the pinned OpenCode dependencies.

## Install

Pin the full plugin version in `opencode.jsonc`:

```jsonc
{
  "plugins": ["@op1/opencode-anthropic-auth@2.0.3"]
}
```

Restart OpenCode, run `/connect`, and select Anthropic's Claude account sign-in.

## Request changes

For the plugin's OAuth connection, it:

- Adds the Anthropic OAuth authorization, beta, and Claude CLI headers.
- Removes `x-api-key`.
- Prepends this system block:

```text
You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

The existing OpenCode prompt stays unchanged. The plugin does not rewrite messages, tools, URLs, request bodies, or responses.

## Development

```bash
bun install --frozen-lockfile
bun test
bun run types
bun run lint
bun run format:check
bun run build
```

For a local build, point `plugins` to the absolute `dist` directory and restart OpenCode.

## License

MIT
