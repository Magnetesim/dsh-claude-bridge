/**
 * dsh-claude-bridge — a loopback-only HTTP bridge into the running dsh web Host.
 *
 * Claude Code (or any local process holding the token) can create a DeepSeek
 * session exactly like the web UI does — inside the same Host, attached to the
 * workspace that owns the requested cwd — then send follow-up prompts, poll
 * compact progress, read the final answer, and cancel a turn.
 *
 * Security: every request must come from a loopback socket, carry a loopback
 * `Host` header, have no cross-site origin/fetch metadata, and present the
 * `X-Claude-Bridge-Token` read from `$DSH_HOME/claude-bridge.token` (created
 * with 32 random bytes, mode 0600, on first start). The token is never logged.
 *
 * Optional phase 2: the `ask_claude` tool appends a question to
 * `$DSH_HOME/claude-bridge/outbox.jsonl`, readable through GET /outbox.
 *
 * @module dsh-claude-bridge
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'

const PREFIX = '/claude-bridge/v1'
const VERSION = '1.0.0'
const BODY_LIMIT_BYTES = 1024 * 1024

/** Host services this plugin needs; Cordis resolves them before `apply` runs. */
export const inject = [
  'webServer',
  'sessionController',
  'agents',
  'workspaceRegistry',
  'agentDefaultModel',
]

/** A transport-level failure answered directly by the bridge. */
class HttpError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} code machine-readable error code.
   * @param {string} message human-readable message (never contains secrets).
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** Resolve the DSH home the same way the Host does. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

const TOKEN_FILE = join(dshHome(), 'claude-bridge.token')
const OUTBOX_DIR = join(dshHome(), 'claude-bridge')
const OUTBOX_FILE = join(OUTBOX_DIR, 'outbox.jsonl')

/**
 * Read the bridge token, creating it on first start.
 * @returns {string} the 64-hex-character token.
 */
function ensureToken() {
  mkdirSync(dshHome(), { recursive: true })
  try {
    const fd = openSync(TOKEN_FILE, 'wx', 0o600)
    try {
      const token = randomBytes(32).toString('hex')
      writeSync(fd, `${token}\n`)
      return token
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new Error(`${TOKEN_FILE} must contain one 64-hex-character token`)
  }
  try {
    chmodSync(TOKEN_FILE, 0o600)
  } catch {
    // Best effort: a pre-existing file may be owned by a different mode; the
    // token still gates requests.
  }
  return token
}

/**
 * Constant-time token comparison.
 * @param {unknown} provided header value.
 * @param {string} expected configured token.
 * @returns {boolean} whether the request may proceed.
 */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string') return false
  const left = Buffer.from(provided, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** @param {string | undefined} address socket remote address. */
function isLoopbackAddress(address) {
  if (address === undefined || address === '') return false
  let value = address
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)
  if (isIP(value) === 4) return value.split('.')[0] === '127'
  if (isIP(value) === 6) return value === '::1'
  return false
}

/** @param {string} hostname parsed or raw host name. */
function isLoopbackHostname(hostname) {
  let value = hostname.trim().toLowerCase()
  if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'))
  if (value.endsWith('.')) value = value.slice(0, -1)
  if (value === 'localhost') return true
  if (isIP(value) === 4) return value.split('.')[0] === '127'
  if (isIP(value) === 6) return value === '::1'
  return false
}

/** @param {string | undefined} header raw `Host` header value. */
function isLoopbackHostHeader(header) {
  if (header === undefined || header.trim() === '') return false
  try {
    return isLoopbackHostname(new URL(`http://${header}`).hostname)
  } catch {
    return false
  }
}

/** @param {string} origin raw `Origin` header value. */
function isLoopbackOrigin(origin) {
  if (origin === 'null') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

/** @param {import('node:http').ServerResponse} res */
function sendMethodNotAllowed(res, allow) {
  sendJson(res, 405, { error: 'method-not-allowed', allow }, { allow })
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        failed = true
        req.resume()
        reject(new HttpError(413, 'payload-too-large', `request body exceeds ${BODY_LIMIT_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'invalid-json', 'request body is not valid JSON'))
      }
    })
    req.on('error', (error) => {
      if (!failed) reject(error)
    })
  })
}

/** @param {unknown} value */
function asObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid-body', 'request body must be a JSON object')
  }
  return value
}

/** @param {unknown} value @param {string} name */
function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid-body', `"${name}" must be a non-empty string`)
  }
  return value
}

/** @param {unknown} value @param {string} name */
function optionalString(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid-body', `"${name}" must be a non-empty string when present`)
  }
  return value
}

/** @param {unknown} value @param {string} name */
function requireAbsolutePath(value, name) {
  const text = requireString(value, name)
  if (!isAbsolute(text)) throw new HttpError(400, 'invalid-body', `"${name}" must be an absolute path`)
  return resolvePath(text)
}

/** @param {unknown} value @param {number} fallback @param {number} max */
function parseLimit(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new HttpError(400, 'invalid-query', '"limit" must be a positive integer')
  }
  return Math.min(parsed, max)
}

/** @param {unknown} value */
function isNotFoundError(value) {
  if (value === null || typeof value !== 'object') return false
  if (value.code === 'session/not-found') return true
  if (value.name === 'ApiSessionNotFound') return true
  return typeof value.message === 'string' && /session .* not found|not found \(not attached\)/i.test(value.message)
}

/** @param {Error & { status?: number; code?: string }} error */
function toHttpError(error) {
  if (error instanceof HttpError) return error
  const code = typeof error?.code === 'string' ? error.code : undefined
  const message = isErrorLike(error) ? error.message : String(error)
  if (isNotFoundError(error)) return new HttpError(404, 'session/not-found', message)
  if (code === 'gateway/bad-request') return new HttpError(400, code, message)
  if (code === 'session/conflict' || code === 'session/agent-busy' || code === 'agent-preset/conflict' || code === 'session/workspace-attach-failed') {
    return new HttpError(409, code, message)
  }
  if (code === 'session/model-unavailable' || code === 'session/attachment-invalid' || code === 'session/title-invalid') {
    return new HttpError(400, code, message)
  }
  if (code === 'workspace/not-found') return new HttpError(404, code, message)
  return new HttpError(500, code ?? 'gateway/internal', message)
}

/** @param {unknown} value */
function isErrorLike(value) {
  return value !== null && typeof value === 'object' && typeof value.message === 'string'
}

/** @param {unknown} message a Session message. @returns {string} */
function messageText(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  let text = ''
  for (const part of message.content) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      text += part.text
    }
  }
  return text
}

/** @param {string} text @param {number} max */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** @param {readonly unknown[]} events @returns {string | null} */
function latestSessionTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title
  }
  return null
}

/** @param {readonly unknown[]} events @returns {string | null} */
function lastCompletedAssistantText(events) {
  let endIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') {
      endIndex = index
      break
    }
  }
  if (endIndex === -1) return null
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') break
    if (event?.type === 'assistant/message') return messageText(event.data?.message)
  }
  return null
}

/**
 * Project one durable Session event onto the compact polling shape.
 * @param {any} event
 * @returns {object | null}
 */
function compactEvent(event) {
  if (event === null || typeof event !== 'object') return null
  const seq = event.seq
  switch (event.type) {
    case 'user/message':
      return { seq, type: 'user', text: messageText(event.data) }
    case 'assistant/message':
      return { seq, type: 'assistant', text: messageText(event.data?.message) }
    case 'tool/call':
      return {
        seq,
        type: 'tool_call',
        name: typeof event.data?.name === 'string' ? event.data.name : '',
        arguments: truncate(typeof event.data?.arguments === 'string' ? event.data.arguments : '', 300),
      }
    case 'tool/result': {
      const result = {
        seq,
        type: 'tool_result',
        text: truncate(messageText(event.data?.message), 500),
      }
      if (event.data?.error !== undefined) {
        result.error = {
          name: event.data.error?.name ?? 'error',
          code: event.data.error?.code ?? 'unknown',
          ...(typeof event.data.error?.reason === 'string' ? { reason: event.data.error.reason } : {}),
        }
      } else if (event.data?.message?.isError === true) {
        result.error = { name: 'tool-error', code: 'tool-error' }
      }
      return result
    }
    case 'turn/start':
      return { seq, type: 'turn_start', turn: event.data?.turn ?? null }
    case 'turn/end':
      return {
        seq,
        type: 'turn_end',
        turn: event.data?.turn ?? null,
        status: event.data?.reason?.kind ?? 'unknown',
        ...(typeof event.data?.reason?.error?.message === 'string'
          ? { error: event.data.reason.error.message }
          : {}),
      }
    default:
      return null
  }
}

/**
 * Register the bridge.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  let token
  try {
    token = ensureToken()
  } catch (error) {
    ctx.logger.error(`claude-bridge: cannot load ${TOKEN_FILE}: ${error instanceof Error ? error.message : String(error)}`)
    token = undefined
  }

  // Service methods on the official UI path always receive a caller signal.
  const bridgeLifetime = new AbortController()
  const bridgeSignal = bridgeLifetime.signal
  ctx.effect(() => () => bridgeLifetime.abort(new Error('claude-bridge disposed')))

  const originOf = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the workspace that owns `cwd`, creating one for an unowned directory.
   * @param {string} cwd absolute directory.
   */
  const workspaceFor = async (cwd) => {
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error) {
      throw new HttpError(400, 'invalid-cwd', `cannot create or use "${cwd}": ${isErrorLike(error) ? error.message : String(error)}`)
    }
    return (await ctx.workspaceRegistry.resolveByPath(cwd)) ?? (await ctx.workspaceRegistry.create(cwd, basename(cwd)))
  }

  /**
   * Apply an optional model selection to a freshly created session.
   * @param {string} sessionId
   * @param {Record<string, unknown>} body
   */
  const applyModelSelection = async (sessionId, body) => {
    const providerOption = optionalString(body.provider, 'provider')
    const modelOption = optionalString(body.model, 'model')
    const effortOption = optionalString(body.reasoningEffort, 'reasoningEffort')
    if (modelOption === undefined && effortOption === undefined) return
    let provider = providerOption
    let model = modelOption
    if (model === undefined) {
      const fallback = ctx.agentDefaultModel.currentSelection()
      provider = provider ?? fallback.provider
      model = fallback.model
    }
    if (provider === undefined) {
      const catalog = await ctx.sessionController.modelCatalog()
      const matches = catalog.groups.filter((group) => group.models.some((entry) => entry.id === model))
      if (matches.length === 1) {
        provider = matches[0].id
      } else if (matches.length === 0) {
        throw new HttpError(400, 'invalid-body', `"model" ${JSON.stringify(model)} is not in the current model catalog`)
      } else {
        throw new HttpError(400, 'invalid-body', `"model" ${JSON.stringify(model)} is ambiguous; pass "provider" too`)
      }
    }
    await ctx.sessionController.selectModel({
      sessionId,
      provider,
      model,
      ...(effortOption === undefined ? {} : { reasoningEffort: effortOption }),
    })
  }

  /** @param {Record<string, unknown>} body */
  const createSession = async (body) => {
    const cwd = requireAbsolutePath(body.cwd, 'cwd')
    const prompt = requireString(body.prompt, 'prompt')
    const title = optionalString(body.title, 'title')
    const agentPreset = optionalString(body.agentPreset, 'agentPreset')
    const reuseSessionId = optionalString(body.sessionId, 'sessionId')

    const workspace = await workspaceFor(cwd)
    const created = await ctx.sessionController.create({
      workspaceId: workspace.id,
      ...(reuseSessionId === undefined ? {} : { sessionId: reuseSessionId }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    const sessionId = created.sessionId
    try {
      if (title !== undefined) await ctx.sessionController.rename({ sessionId, title })
      await applyModelSelection(sessionId, body)
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, bridgeSignal)
    } catch (error) {
      // The session exists and is visible; report the prompt/model failure but
      // keep the created identity recoverable in the error payload.
      const failure = toHttpError(error)
      failure.message = `session ${sessionId} was created, but the post-create step (title, model, or first prompt) failed: ${failure.message}`
      throw failure
    }
    return { sessionId, webUrl: `${originOf() ?? ''}/` }
  }

  /** @param {string} sessionId */
  const readInspection = async (sessionId) => {
    try {
      return await ctx.sessionController.inspect(sessionId)
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw error
    }
  }

  /** @param {string} sessionId */
  const sessionStatus = async (sessionId) => {
    const inspection = await readInspection(sessionId)
    if (inspection === undefined) throw new HttpError(404, 'session/not-found', `session "${sessionId}" not found`)
    const events = Array.isArray(inspection.events) ? inspection.events : []
    const last = events.length === 0 ? undefined : events[events.length - 1]
    let turnCount = 0
    for (const event of events) if (event?.type === 'turn/start') turnCount += 1
    return {
      sessionId,
      title: latestSessionTitle(events),
      cwd: typeof inspection.meta?.cwd === 'string' ? inspection.meta.cwd : null,
      running: ctx.agents.get(sessionId)?.status === 'running',
      turnCount,
      lastSeq: typeof last?.seq === 'number' ? last.seq : 0,
      updatedAt: typeof last?.time === 'number' ? last.time : (inspection.meta?.createdAt ?? null),
      lastAssistantText: lastCompletedAssistantText(events),
    }
  }

  /** @param {string} sessionId @param {URLSearchParams} query */
  const sessionEvents = async (sessionId, query) => {
    const inspection = await readInspection(sessionId)
    if (inspection === undefined) throw new HttpError(404, 'session/not-found', `session "${sessionId}" not found`)
    const events = Array.isArray(inspection.events) ? inspection.events : []
    const afterRaw = query.get('afterSeq')
    const afterSeq = afterRaw === null ? 0 : Number(afterRaw)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new HttpError(400, 'invalid-query', '"afterSeq" must be a non-negative integer')
    }
    const limit = parseLimit(query.get('limit'), 200, 1000)
    const pending = events.filter((event) => typeof event?.seq === 'number' && event.seq > afterSeq)
    // The limit counts compact events, not raw ones: non-compact bookkeeping
    // events are skipped and only advance the cursor.
    const compact = []
    let nextSeq = afterSeq
    let index = 0
    for (; index < pending.length; index += 1) {
      const event = pending[index]
      nextSeq = event.seq
      const entry = compactEvent(event)
      if (entry === null) continue
      compact.push(entry)
      if (compact.length >= limit) {
        index += 1
        break
      }
    }
    return {
      sessionId,
      events: compact,
      nextSeq,
      hasMore: index < pending.length,
    }
  }

  /** @param {string} sessionId */
  const promptSession = async (sessionId, body) => {
    const text = requireString(body.text, 'text')
    const delivery = optionalString(body.delivery, 'delivery')
    if (delivery !== undefined && delivery !== 'queue' && delivery !== 'steer') {
      throw new HttpError(400, 'invalid-body', '"delivery" must be "queue" or "steer" when present')
    }
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: delivery === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, bridgeSignal)
    return { accepted: true }
  }

  /** @param {string} sessionId */
  const cancelSession = async (sessionId) => {
    ctx.sessionController.cancel({ sessionId })
    return { cancelled: true }
  }

  /** @param {URLSearchParams} query */
  const listSessions = async (query) => {
    const cwd = requireAbsolutePath(query.get('cwd'), 'cwd')
    const limit = parseLimit(query.get('limit'), 20, 500)
    let workspace
    try {
      workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
    } catch {
      workspace = undefined
    }
    if (workspace === undefined) return { cwd, workspaceId: null, sessions: [] }
    const memberIds = new Set(workspace.sessionIds)
    const summaries = await ctx.sessionController.list({})
    const rows = summaries.items
      .filter((item) => memberIds.has(item.sessionId))
      // The sidebar hides subagent children; mirror that for workspace listings.
      .filter((item) => item.origin !== 'subagent' && item.parentSessionId === undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map((item) => ({
        sessionId: item.sessionId,
        title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : null,
        running: item.running,
        updatedAt: item.updatedAt,
      }))
    return { cwd: workspace.path, workspaceId: workspace.id, sessions: rows }
  }

  /** @param {URLSearchParams} query */
  const readOutbox = async (query) => {
    const afterRaw = query.get('after')
    const after = afterRaw === null ? 0 : Number(afterRaw)
    if (!Number.isFinite(after) || after < 0) {
      throw new HttpError(400, 'invalid-query', '"after" must be a non-negative number')
    }
    let text = ''
    try {
      text = await readFile(OUTBOX_FILE, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const items = []
    let next = after
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof entry?.ts !== 'number' || entry.ts <= after) continue
      items.push(entry)
      if (entry.ts > next) next = entry.ts
    }
    items.sort((left, right) => left.ts - right.ts)
    return { outbox: OUTBOX_FILE, items, next: Math.max(next, after) }
  }

  /**
   * One HTTP request.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handle = async (req, res) => {
    try {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: 'forbidden', reason: 'remote address is not loopback' })
        return
      }
      if (!isLoopbackHostHeader(req.headers.host)) {
        sendJson(res, 403, { error: 'forbidden', reason: 'Host header is not loopback' })
        return
      }
      const origin = req.headers.origin
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        sendJson(res, 403, { error: 'forbidden', reason: 'Origin is not loopback' })
        return
      }
      const fetchSite = req.headers['sec-fetch-site']
      if (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site') {
        sendJson(res, 403, { error: 'forbidden', reason: 'cross-site requests are refused' })
        return
      }
      if (token === undefined) {
        sendJson(res, 503, { error: 'bridge-token-unavailable', reason: `cannot read or create ${TOKEN_FILE}` })
        return
      }
      if (!tokenMatches(req.headers['x-claude-bridge-token'], token)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://bridge.invalid')
      if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
        sendJson(res, 404, { error: 'not-found' })
        return
      }
      const segments = url.pathname
        .slice(PREFIX.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => decodeURIComponent(segment))
      const method = req.method ?? 'GET'

      if (segments.length === 1 && segments[0] === 'health') {
        if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        sendJson(res, 200, { ok: true, version: VERSION, webUrl: `${originOf() ?? ''}/` })
        return
      }

      if (segments.length === 1 && segments[0] === 'sessions') {
        if (method === 'GET') {
          sendJson(res, 200, await listSessions(url.searchParams))
          return
        }
        if (method === 'POST') {
          sendJson(res, 200, await createSession(asObject(await readJsonBody(req))))
          return
        }
        return sendMethodNotAllowed(res, 'GET, POST')
      }

      if (segments.length === 1 && segments[0] === 'outbox') {
        if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        sendJson(res, 200, await readOutbox(url.searchParams))
        return
      }

      if (segments.length >= 2 && segments[0] === 'sessions') {
        const sessionId = segments[1]
        if (!/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
          throw new HttpError(400, 'invalid-session-id', 'session id contains unsupported characters')
        }
        if (segments.length === 2) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          sendJson(res, 200, await sessionStatus(sessionId))
          return
        }
        if (segments.length === 3) {
          const action = segments[2]
          if (action === 'prompt') {
            if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
            sendJson(res, 200, await promptSession(sessionId, asObject(await readJsonBody(req))))
            return
          }
          if (action === 'events') {
            if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
            sendJson(res, 200, await sessionEvents(sessionId, url.searchParams))
            return
          }
          if (action === 'cancel') {
            if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
            sendJson(res, 200, await cancelSession(sessionId))
            return
          }
        }
      }

      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      const failure = toHttpError(error)
      if (failure.status >= 500) {
        ctx.logger.warn(`claude-bridge: ${req.method ?? '?'} ${req.url ?? '?'} failed: ${failure.message}`)
      }
      if (!res.headersSent) {
        sendJson(res, failure.status, { error: failure.code, message: failure.message })
      } else {
        res.end()
      }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handle }))
  ctx.logger.info(`claude-bridge: registered ${PREFIX} on ${originOf() ?? 'the web server'}`)

  // Phase 2: DeepSeek -> Claude channel. The tool only queues; Claude reads
  // GET /outbox and answers through POST /sessions/:id/prompt.
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() =>
      toolsCtx.tools.register({
        name: 'ask_claude',
        description:
          'Queue a question for Claude Code, the local external agent watching the claude-bridge outbox. ' +
          'This returns immediately; the answer arrives later as a user message in this session.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question or request for Claude Code.' },
          },
          required: ['question'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              queued: { type: 'boolean' },
              ts: { type: 'number' },
            },
            required: ['queued', 'ts'],
            additionalProperties: false,
          },
          render: () => [{ type: 'text', text: 'queued; the answer will arrive as a user message' }],
        },
        async execute(args, exec) {
          const question = requireString(args?.question, 'question')
          await mkdir(OUTBOX_DIR, { recursive: true, mode: 0o700 })
          const ts = Date.now()
          const entry = {
            ts,
            sessionId: exec.agent?.id ?? null,
            question,
          }
          await appendFile(OUTBOX_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
          return { queued: true, ts }
        },
      }),
    )
  })
}
