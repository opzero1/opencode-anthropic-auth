import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Credential } from '@opencode-ai/plugin'
import { Effect } from 'effect'
import { AnthropicAuthPlugin } from '../index.ts'

type OAuthRegistration = {
  integrationID: string
  method: { id: string; type: string; label: string }
  authorize: () => Effect.Effect<{
    mode: string
    url: string
    callback: (code: string) => Effect.Effect<Credential.OAuth, unknown>
  }>
  refresh: (
    credential: Credential.OAuth,
  ) => Effect.Effect<Credential.OAuth, unknown>
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function harness(credentialType: 'oauth' | 'key' = 'oauth') {
  let oauth: OAuthRegistration | undefined
  let requestHook:
    | ((event: {
        model: { providerID: string }
        request: Request
      }) => Effect.Effect<void> | void)
    | undefined
  let responseHook:
    | ((event: {
        model: { providerID: string }
        response: Response
      }) => Effect.Effect<void> | void)
    | undefined

  const credential =
    credentialType === 'oauth'
      ? ({
          type: 'oauth',
          methodID: 'oauth',
          refresh: 'refresh-token',
          access: 'access-token',
          expires: Date.now() + 60_000,
        } as Credential.OAuth)
      : ({ type: 'key', key: 'native-key' } as Credential.Key)

  const context = {
    integration: {
      transform: (transform: (draft: unknown) => void) =>
        Effect.sync(() => {
          transform({
            method: {
              update: (registration: OAuthRegistration) => {
                oauth = registration
              },
            },
          })
          return { dispose: Effect.void }
        }),
      connection: {
        active: () =>
          Effect.succeed({ type: 'credential', id: 'credential-id' }),
        resolve: () => Effect.succeed(credential),
      },
    },
    session: {
      hook: (name: string, hook: typeof requestHook | typeof responseHook) =>
        Effect.sync(() => {
          if (name === 'http.request') requestHook = hook as typeof requestHook
          if (name === 'http.response')
            responseHook = hook as typeof responseHook
          return { dispose: Effect.void }
        }),
    },
  }

  return {
    context,
    credential: credential as Credential.OAuth,
    getOAuth: () => oauth,
    getRequestHook: () => requestHook,
    getResponseHook: () => responseHook,
  }
}

async function loadPlugin(context: unknown) {
  await Effect.runPromise(
    Effect.scoped(AnthropicAuthPlugin.effect(context as never)),
  )
}

describe('AnthropicAuthPlugin', () => {
  test('exports the V2 plugin contract', () => {
    expect(AnthropicAuthPlugin.id).toBe('anthropic-auth')
    expect(AnthropicAuthPlugin.effect).toBeFunction()
  })

  test('registers Claude Pro/Max login and token refresh', async () => {
    const testHarness = harness()
    await loadPlugin(testHarness.context)

    const oauth = testHarness.getOAuth()
    expect(oauth?.integrationID).toBe('anthropic')
    expect(oauth?.method).toEqual({
      id: 'oauth',
      type: 'oauth',
      label: 'Claude Pro/Max',
    })

    globalThis.fetch = mock(async () =>
      Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch

    const authorization = await Effect.runPromise(oauth!.authorize())
    const state = new URL(authorization?.url ?? '').searchParams.get('state')
    const credential = await Effect.runPromise(
      authorization.callback(`code#${state}`),
    )
    expect(credential).toMatchObject({
      type: 'oauth',
      methodID: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
    })

    const refreshed = await Effect.runPromise(
      oauth!.refresh(testHarness.credential),
    )
    expect(refreshed).toMatchObject({
      type: 'oauth',
      methodID: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
    })
  })

  test('rewrites Anthropic OAuth requests and responses', async () => {
    const testHarness = harness()
    await loadPlugin(testHarness.context)
    const event = {
      model: { providerID: 'anthropic' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'invalid' },
        body: JSON.stringify({
          system: 'You are OpenCode\n\nKeep this instruction.',
          messages: [{ role: 'user', content: 'Run the tool' }],
          tools: [{ name: 'read', description: 'Read a file' }],
        }),
      }),
    }
    const hookResult = testHarness.getRequestHook()?.(event)
    if (Effect.isEffect(hookResult)) await Effect.runPromise(hookResult)

    expect(event.request.url).toBe(
      'https://api.anthropic.com/v1/messages?beta=true',
    )
    expect(event.request.headers.get('authorization')).toBe(
      'Bearer access-token',
    )
    expect(event.request.headers.has('x-api-key')).toBe(false)
    expect(event.request.headers.get('anthropic-beta')).toContain(
      'oauth-2025-04-20',
    )
    const body = (await event.request.json()) as {
      tools: Array<{ name: string }>
      system: Array<{ text: string }>
    }
    expect(body.tools[0]?.name).toBe('mcp_Read')
    expect(body.system[0]?.text).toContain('x-anthropic-billing-header')

    const responseEvent = {
      model: { providerID: 'anthropic' },
      response: new Response('data: {"name":"mcp_Read"}\n\n'),
    }
    const responseHook = testHarness.getResponseHook()?.(responseEvent)
    if (Effect.isEffect(responseHook)) await Effect.runPromise(responseHook)
    expect(await responseEvent.response.text()).toContain('"name": "read"')
  })

  test('does not intercept API-key requests', async () => {
    const testHarness = harness('key')
    await loadPlugin(testHarness.context)
    const request = new Request('https://api.anthropic.com/v1/messages', {
      headers: { 'x-api-key': 'native-key' },
    })
    const event = {
      model: { providerID: 'anthropic' },
      request,
    }
    const hookResult = testHarness.getRequestHook()?.(event)
    if (Effect.isEffect(hookResult)) await Effect.runPromise(hookResult)

    expect(event.request).toBe(request)
  })
})
