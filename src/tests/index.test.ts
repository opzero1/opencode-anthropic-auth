import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Credential } from '@opencode-ai/plugin'
import { Effect, type Scope } from 'effect'
import { CLAUDE_CODE_IDENTITY } from '../constants.ts'
import { AnthropicAuthPlugin } from '../index.ts'

type OAuthRegistration = {
  integrationID: string
  method: { id: string; type: string; label: string }
  authorize: () => Effect.Effect<
    {
      mode: string
      url: string
      callback: Effect.Effect<Credential.OAuth, unknown>
    },
    unknown,
    Scope.Scope
  >
  refresh: (
    credential: Credential.OAuth,
  ) => Effect.Effect<Credential.OAuth, unknown>
}

type ContextEvent = {
  model: { providerID: string }
  system: Array<{ type: string; text: string }>
}

type ModelRequestEvent = {
  model: { providerID: string }
  baseURL?: string
  headers: Record<string, string>
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function harness(credentialType: 'oauth' | 'key' = 'oauth') {
  let oauth: OAuthRegistration | undefined
  let contextHook:
    | ((event: ContextEvent) => Effect.Effect<void> | void)
    | undefined
  let modelRequestHook:
    | ((event: ModelRequestEvent) => Effect.Effect<void> | void)
    | undefined
  const hookNames: string[] = []
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
      hook: (
        name: string,
        hook:
          | ((event: ContextEvent) => Effect.Effect<void> | void)
          | ((event: ModelRequestEvent) => Effect.Effect<void> | void),
      ) =>
        Effect.sync(() => {
          hookNames.push(name)
          if (name === 'context') contextHook = hook as typeof contextHook
          if (name === 'model.request')
            modelRequestHook = hook as typeof modelRequestHook
          return { dispose: Effect.void }
        }),
    },
  }

  return {
    context,
    credential: credential as Credential.OAuth,
    getOAuth: () => oauth,
    getContextHook: () => contextHook,
    getModelRequestHook: () => modelRequestHook,
    getHookNames: () => hookNames,
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

  test('registers browser login and token refresh', async () => {
    const testHarness = harness()
    await loadPlugin(testHarness.context)
    const oauth = testHarness.getOAuth()
    expect(oauth?.integrationID).toBe('anthropic')
    expect(oauth?.method).toEqual({
      id: 'oauth',
      type: 'oauth',
      label: 'Claude account (Pro/Max/Team/Enterprise)',
    })

    globalThis.fetch = mock(async (input, init) => {
      if (input.toString().startsWith('http://localhost:53692/callback')) {
        return originalFetch(input, init)
      }
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      })
    }) as unknown as typeof fetch

    const credential = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const authorization = yield* oauth!.authorize()
          expect(authorization.mode).toBe('auto')
          const url = new URL(authorization.url)
          expect(url.searchParams.get('redirect_uri')).toBe(
            'http://localhost:53692/callback',
          )
          yield* Effect.promise(() =>
            globalThis.fetch(
              `http://localhost:53692/callback?code=code&state=${url.searchParams.get('state')}`,
            ),
          )
          return yield* authorization.callback
        }),
      ),
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

  test('adds only the Claude identity and OAuth headers', async () => {
    const testHarness = harness()
    await loadPlugin(testHarness.context)
    expect(testHarness.getHookNames()).toEqual(['context', 'model.request'])

    const contextEvent: ContextEvent = {
      model: { providerID: 'anthropic' },
      system: [
        { type: 'text', text: 'You are OpenCode. Keep this unchanged.' },
      ],
    }
    const contextResult = testHarness.getContextHook()?.(contextEvent)
    if (Effect.isEffect(contextResult)) await Effect.runPromise(contextResult)
    const secondContextResult = testHarness.getContextHook()?.(contextEvent)
    if (Effect.isEffect(secondContextResult))
      await Effect.runPromise(secondContextResult)

    expect(contextEvent.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'You are OpenCode. Keep this unchanged.' },
    ])

    const requestEvent: ModelRequestEvent = {
      model: { providerID: 'anthropic' },
      baseURL: 'https://api.anthropic.com',
      headers: {
        'anthropic-beta': 'existing-beta',
        'Anthropic-Beta': 'second-beta',
        'x-api-key': 'invalid',
        'X-API-Key': 'also-invalid',
        'x-untouched': 'same',
      },
    }
    const requestResult = testHarness.getModelRequestHook()?.(requestEvent)
    if (Effect.isEffect(requestResult)) await Effect.runPromise(requestResult)

    expect(requestEvent.baseURL).toBe('https://api.anthropic.com')
    expect(requestEvent.headers.authorization).toBe('Bearer access-token')
    expect(requestEvent.headers['x-api-key']).toBeUndefined()
    expect(requestEvent.headers['X-API-Key']).toBeUndefined()
    expect(requestEvent.headers['anthropic-beta']).toBe(
      'oauth-2025-04-20,interleaved-thinking-2025-05-14,existing-beta,second-beta',
    )
    expect(requestEvent.headers['Anthropic-Beta']).toBeUndefined()
    expect(requestEvent.headers['x-untouched']).toBe('same')
  })

  test('does not modify API-key requests', async () => {
    const testHarness = harness('key')
    await loadPlugin(testHarness.context)
    const contextEvent: ContextEvent = {
      model: { providerID: 'anthropic' },
      system: [{ type: 'text', text: 'unchanged' }],
    }
    const contextResult = testHarness.getContextHook()?.(contextEvent)
    if (Effect.isEffect(contextResult)) await Effect.runPromise(contextResult)
    expect(contextEvent.system).toEqual([{ type: 'text', text: 'unchanged' }])

    const requestEvent: ModelRequestEvent = {
      model: { providerID: 'anthropic' },
      headers: { 'x-api-key': 'native-key' },
    }
    const requestResult = testHarness.getModelRequestHook()?.(requestEvent)
    if (Effect.isEffect(requestResult)) await Effect.runPromise(requestResult)
    expect(requestEvent.headers).toEqual({ 'x-api-key': 'native-key' })
  })
})
