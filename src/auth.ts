import { createServer } from 'node:http'
import {
  AUTHORIZE_URLS,
  CALLBACK_HOST,
  CALLBACK_PATH,
  CALLBACK_PORT,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants.ts'
import { generatePKCE } from './pkce.ts'

type CallbackParams = {
  code: string
  state: string
}

export type CallbackServer = {
  close: () => Promise<void>
  waitForCode: () => Promise<CallbackParams>
}

export type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, '')
}

export function startCallbackServer(
  expectedState: string,
): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode: (value: CallbackParams) => void
    let rejectCode: (error: Error) => void
    let settled = false
    const code = new Promise<CallbackParams>((resolveWait, rejectWait) => {
      resolveCode = resolveWait
      rejectCode = rejectWait
    })
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }

      const error =
        url.searchParams.get('error_description') ??
        url.searchParams.get('error')
      const callback = {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
      }
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(
          '<h1>Anthropic authorization failed</h1><p>You can close this window.</p>',
        )
        if (!settled) rejectCode(new Error(error))
        settled = true
        return
      }
      if (
        !callback.code ||
        !callback.state ||
        callback.state !== expectedState
      ) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<h1>Invalid Anthropic OAuth callback</h1>')
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(
        '<h1>Anthropic authorization complete</h1><p>You can close this window.</p>',
      )
      if (!settled) resolveCode({ code: callback.code, state: callback.state })
      settled = true
    })

    server.once('error', reject)
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        waitForCode: () => code,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            if (!server.listening) {
              resolveClose()
              return
            }
            server.close((error) => {
              if (error) rejectClose(error)
              else resolveClose()
            })
          }),
      })
    })
  })
}

function parseCallbackInput(input: string) {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) {
      return { code, state }
    }
  } catch {
    // Fall through to legacy/manual formats.
  }

  const hashSplits = trimmed.split('#')
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) {
    return { code, state }
  }

  return null
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })

  if (!result.ok) {
    return {
      type: 'failed',
    }
  }

  const json = (await result.json()) as {
    refresh_token: string
    access_token: string
    expires_in: number
  }

  return {
    type: 'success',
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function authorize(
  mode: 'max' | 'console',
  redirectUri = CODE_CALLBACK_URL,
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri,
    state,
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed' }

export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  const callback = parseCallbackInput(input)
  if (!callback) {
    return {
      type: 'failed',
    }
  }

  if (expectedState && callback.state !== expectedState) {
    return {
      type: 'failed',
    }
  }

  return exchangeCode(callback, verifier, redirectUri)
}
