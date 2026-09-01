# OpenCode Anthropic OAuth

Unofficial Anthropic subscription OAuth for OpenCode V2.

> [!WARNING]
> Anthropic may restrict or suspend subscription accounts that use unofficial clients. Use this plugin at your own risk.

## Compatibility

This release is pinned to one OpenCode V2 beta:

| Component | Version |
| --- | --- |
| OpenCode V2 | `0.0.0-beta-18743` |
| This plugin | `0.0.0-beta-18743` |
| `@opencode-ai/plugin` | `0.0.0-beta-18743` |
| Effect | `4.0.0-rc.112` |

Do not update these independently. A new OpenCode beta needs a new tested plugin release.

## Install

Pin the full plugin version in `opencode.jsonc`:

```jsonc
{
  "plugins": ["@op1/opencode-anthropic-auth@0.0.0-beta-18743"]
}
```

Then start browser login:

```bash
opencode2 auth login anthropic --method oauth
```

If OpenCode cached an older package, remove `~/.cache/opencode/packages/@op1` and restart it.

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
