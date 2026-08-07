import { Credential, Integration, Plugin } from '@opencode-ai/plugin/effect'
import { Effect } from 'effect'
import { authorize, exchange } from './auth.ts'
import { CLIENT_ID, TOKEN_URL, USER_AGENT } from './constants.ts'
import {
  createStrippedStream,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const integrationID = 'anthropic'
const methodID = Integration.MethodID.make('oauth')

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
}

export const AnthropicAuthPlugin = Plugin.define({
  id: 'anthropic-auth',
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.integration.transform((integrations) => {
        integrations.method.update({
          integrationID,
          method: {
            id: methodID,
            type: 'oauth',
            label: 'Claude Pro/Max',
          },
          authorize: () =>
            Effect.gen(function* () {
              const result = yield* Effect.promise(() => authorize('max'))
              return {
                mode: 'code' as const,
                url: result.url,
                instructions: 'Paste the authorization code here:',
                callback: (code: string) =>
                  Effect.gen(function* () {
                    const credentials = yield* Effect.promise(() =>
                      exchange(
                        code,
                        result.verifier,
                        result.redirectUri,
                        result.state,
                      ),
                    )
                    if (credentials.type === 'failed') {
                      return yield* Effect.fail(
                        new Error(
                          'Anthropic authorization code exchange failed',
                        ),
                      )
                    }
                    return oauthCredential(credentials)
                  }),
              }
            }),
          refresh: (credential) =>
            Effect.promise(() => refreshTokens(credential.refresh)).pipe(
              Effect.map(oauthCredential),
            ),
        })
      })

      yield* ctx.session.hook('http.request', (event) =>
        Effect.gen(function* () {
          if (event.model.providerID !== integrationID) return

          const connection =
            yield* ctx.integration.connection.active(integrationID)
          if (!connection) return

          const credential = yield* ctx.integration.connection
            .resolve(connection)
            .pipe(Effect.orDie)
          if (credential?.type !== 'oauth') return

          const headers = mergeHeaders(event.request)
          setOAuthHeaders(headers, credential.access)
          const body = event.request.body
            ? rewriteRequestBody(
                yield* Effect.promise(() => event.request.clone().text()),
              )
            : undefined
          const rewritten = rewriteUrl(event.request).input
          event.request = new Request(
            rewritten instanceof Request ? rewritten.url : rewritten.toString(),
            {
              method: event.request.method,
              headers,
              body,
            },
          )
        }),
      )

      yield* ctx.session.hook('http.response', (event) =>
        Effect.gen(function* () {
          if (event.model.providerID !== integrationID) return

          const connection =
            yield* ctx.integration.connection.active(integrationID)
          if (!connection) return

          const credential = yield* ctx.integration.connection
            .resolve(connection)
            .pipe(Effect.orDie)
          if (credential?.type !== 'oauth') return

          event.response = createStrippedStream(event.response)
        }),
      )
    }),
})

async function refreshTokens(refreshToken: string) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Anthropic token refresh failed: ${response.status}${body ? ` - ${body}` : ''}`,
    )
  }
  return response.json() as Promise<TokenResponse>
}

function oauthCredential(tokens: {
  refresh: string
  access: string
  expires: number
}): Credential.OAuth
function oauthCredential(tokens: TokenResponse): Credential.OAuth
function oauthCredential(
  tokens: { refresh: string; access: string; expires: number } | TokenResponse,
): Credential.OAuth {
  if ('access_token' in tokens) {
    return Credential.OAuth.make({
      type: 'oauth',
      methodID,
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + tokens.expires_in * 1000,
    })
  }
  return Credential.OAuth.make({ ...tokens, type: 'oauth', methodID })
}

export default AnthropicAuthPlugin
