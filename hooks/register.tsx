import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chat } from '../types'

const ICONO = '🔔'
// Cada cuánto se mira si algún chat ha cambiado, en milisegundos.
const CADA = 5000

// Las rutas se buscan en el ordenador de cada uno: la carpeta personal y las carpetas
// internas de la app de escritorio (macOS), una por cuenta. No están documentadas.
type Rutas = { home: string; chats: string[] }
let rutas: Rutas | undefined
const getRutas = async ($: EngineInterface): Promise<Rutas> => {
  if (rutas && rutas.chats.length > 0) return rutas
  const home = (await $.process.run(['/usr/bin/printenv', 'HOME'])).stdout.trim()
  const base = `${home}/Library/Application Support/Claude/claude-code-sessions`
  const chats: string[] = []
  try {
    for (const account of await $.fs.list(base)) {
      if (account.kind !== 'dir') continue
      for (const org of await $.fs.list(`${base}/${account.name}`)) {
        if (org.kind === 'dir') chats.push(`${base}/${account.name}/${org.name}`)
      }
    }
  } catch {
    // Sin la app de escritorio: no hay chats que leer.
  }
  rutas = { home, chats }
  return rutas
}

// Cada sesión deja en ~/.claude/pendientes un archivo con contenido mientras espera tu permiso o tu respuesta.
const esperas = async ($: EngineInterface) => `${(await getRutas($)).home}/.claude/pendientes`

type Row = Chat & { cliIds: string[]; isArchived: boolean; finishedAt: number; focusedAt: number }

// Lo que se ha visto de cada chat, compartido por todas las sesiones: cuántos turnos llevaba,
// cuándo lo abriste por última vez y si quedó pendiente. Va en ~/.claude/pendientes-estado-2.json:
// el número separa este formato del de versiones anteriores que sigan abiertas en otros chats.
const estado = async ($: EngineInterface) => `${(await getRutas($)).home}/.claude/pendientes-estado-2.json`
type Track = { answeredAt?: number; focusedAt: number; isPending: boolean }

// Cada sesión apunta en ~/.claude/pendientes-fin cuándo terminó de contestar un mensaje tuyo.
// Los turnos que no empiezas tú (el aviso de una tarea, un comando) no cuentan, como en la barra lateral.
const respuestas = async ($: EngineInterface) => `${(await getRutas($)).home}/.claude/pendientes-fin`
const userTurn = atom({ plugin: 'pendientes', key: 'userTurn' } as const, false)

// Cuándo se limpió el aviso por última vez, compartido por todas las sesiones:
// lo que estaba pendiente o esperando antes de ese momento deja de contar.
const limpiado = async ($: EngineInterface) => `${(await getRutas($)).home}/.claude/pendientes-limpiado`
// Segundo clic dentro de este tiempo tras ver la lista: limpia.
const DOBLE = 8000
let shownAt = 0

// Los títulos largos, sobre todo los de los chats laterales, se cortan para que el aviso no se alargue.
const LARGO = 30
// Los chats laterales llevan 💬 en lugar de «btw:».
const corto = (title: string) => {
  const side = /^btw:\s*/i.test(title)
  const text = title.replace(/^btw:\s*/i, '')
  const cut = text.length > LARGO ? `${text.slice(0, LARGO - 1).trimEnd()}…` : text
  return side ? `💬 ${cut}` : cut
}

const chats = atom({ plugin: 'pendientes', key: 'chats' } as const, [], { shape: 'pendientes-2' })
const isBroken = atom({ plugin: 'pendientes', key: 'isBroken' } as const, false)

// Cada archivo se vuelve a leer solo si ha cambiado.
const cache = new Map<string, { mtimeMs: number; row: Row }>()

const load = async ($: EngineInterface, dir: string, name: string, mtimeMs: number) => {
  const known = cache.get(name)
  if (known?.mtimeMs === mtimeMs) return known.row
  try {
    const j = JSON.parse(await $.fs.read(`${dir}/${name}`)) as Record<string, unknown>
    const row: Row = {
      id: name,
      title: String(j.title ?? ''),
      isArchived: j.isArchived === true,
      finishedAt: Number(j.lastTurnEdgeAt ?? 0),
      focusedAt: Number(j.lastFocusedAt ?? 0),
      // La app lo guarda mientras el último turno deja una pregunta sin responder.
      needsAction: j.turnWrapUp != null,
      cliIds: [j.cliSessionId, j.lastAssistantCliSessionId].filter((id): id is string => typeof id === 'string'),
    }
    cache.set(name, { mtimeMs, row })
    return row
  } catch {
    // A medio escribir: vale la lectura anterior, y el siguiente vistazo lo corrige.
    return known?.row
  }
}

const setWaiting = async ($: EngineInterface, isWaiting: boolean) => {
  await $.fs.write(`${await esperas($)}/${await $.session.id()}`, isWaiting ? 'espera' : '')
}

// Solo cuentan las esperas que empezaron después de la última limpieza.
const readWaiting = async ($: EngineInterface, since: number) => {
  try {
    return new Set((await $.fs.list(await esperas($))).filter(file => file.size > 0 && file.mtimeMs > since).map(file => file.name))
  } catch {
    return new Set<string>()
  }
}

const readCleared = async ($: EngineInterface) => {
  try {
    return Number(await $.fs.read(await limpiado($))) || 0
  } catch {
    return 0
  }
}

// Quita todos los avisos: los pendientes se dan por vistos y las esperas actuales dejan de contar.
const clearAll = async ($: EngineInterface) => {
  await $.fs.write(await limpiado($), String(await $.clock.now()))
  try {
    const state = JSON.parse(await $.fs.read(await estado($))) as Record<string, Track>
    for (const track of Object.values(state)) track.isPending = false
    await $.fs.write(await estado($), JSON.stringify(state))
  } catch {
    // Sin estado todavía: no hay nada pendiente que quitar.
  }
  await poll($)
}

const poll = async ($: EngineInterface) => {
  try {
    const files = (
      await Promise.all(
        (await getRutas($)).chats.map(async dir =>
          (await $.fs.list(dir)).filter(file => file.name.startsWith('local_') && file.name.endsWith('.json')).map(file => ({ dir, file })),
        ),
      )
    ).flat()
    if (files.length === 0) throw new Error('no se encuentran los chats de la app')
    const rows = (await Promise.all(files.map(({ dir, file }) => load($, dir, file.name, file.mtimeMs)))).filter(row => row !== undefined)
    // Los chats laterales cuentan igual que los demás.
    const main = rows.filter(row => !row.isArchived)
    const waiting = await readWaiting($, await readCleared($))
    const isWaiting = (row: Row) => row.cliIds.some(id => waiting.has(id))
    const current = Math.max(0, ...main.map(row => row.focusedAt))
    const currentId = main.find(row => row.focusedAt === current)?.id
    let state: Record<string, Track> = {}
    try {
      state = JSON.parse(await $.fs.read(await estado($))) as Record<string, Track>
    } catch {
      // Primera vez: lo que ya existe se da por visto.
    }
    let isChanged = false
    const answered = new Map<string, number>()
    try {
      const dir = await respuestas($)
      for (const file of await $.fs.list(dir)) {
        if (file.size > 0) answered.set(file.name, Number(await $.fs.read(`${dir}/${file.name}`)))
      }
    } catch {
      // Ninguna sesión ha contestado todavía.
    }
    for (const row of main) {
      const answeredAt = Math.max(0, ...row.cliIds.map(id => answered.get(id) ?? 0))
      const prev = state[row.id]
      const next: Track = prev ? { ...prev } : { answeredAt, focusedAt: row.focusedAt, isPending: false }
      // Lo apuntado antes de este cambio no lleva respuesta: se toma como punto de partida.
      if (next.answeredAt === undefined) next.answeredAt = answeredAt
      // Al abrir el chat, deja de estar pendiente.
      if (row.focusedAt > next.focusedAt) {
        next.focusedAt = row.focusedAt
        next.isPending = false
      }
      // Una respuesta nueva a un mensaje tuyo, mientras estás en otro chat, lo deja pendiente.
      if (answeredAt > next.answeredAt) {
        next.isPending = row.id !== currentId
        next.answeredAt = answeredAt
      }
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        state[row.id] = next
        isChanged = true
      }
    }
    if (isChanged) await $.fs.write(await estado($), JSON.stringify(state))
    // Pendiente: terminó un turno mientras estabas en otro chat, y no has vuelto;
    // o espera tu permiso o tu respuesta, y no estás en él.
    const pending: Chat[] = main
      .filter(row => (isWaiting(row) && row.focusedAt < current) || state[row.id]?.isPending === true)
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .map(row => ({ id: row.id, title: row.title, needsAction: row.needsAction || isWaiting(row) }))
    await update($, chats, prev => (JSON.stringify(prev) === JSON.stringify(pending) ? prev : pending))
    await update($, isBroken, () => false)
  } catch {
    await update($, isBroken, () => true)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await setWaiting($, false)
    await poll($)
    $.clock.every(CADA, () => void poll($))
    return result
  })

  // Esta sesión avisa a las demás de que espera a Manu.
  on('classic.PermissionRequest', async ($, e, next) => {
    await setWaiting($, true)
    return next(e)
  })

  // Un mensaje tuyo, no un comando: su respuesta es la que avisa.
  on('prompt.submit', async ($, e, next) => {
    if (!e.text.trimStart().startsWith('/')) await update($, userTurn, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, userTurn))) {
      await update($, userTurn, () => false)
      await $.fs.write(`${await respuestas($)}/${await $.session.id()}`, String(await $.clock.now()))
    }
    return result
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await setWaiting($, true)
    const ran = await next(e)
    await setWaiting($, false)
    return ran
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await setWaiting($, false)
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await setWaiting($, false)
    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    await setWaiting($, false)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await setWaiting($, false)
    return next(e)
  })

  on('classic.SessionEnd', async ($, e, next) => {
    await setWaiting($, false)
    return next(e)
  })

  // En el pie del cuadro de texto, junto a lo que dibujan los demás.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const drawn = await next(e)
    const list = await read($, chats)
    const isActive = list.length > 0
    const broken = await read($, isBroken)
    // A 0 no se dibuja: en el pie no hay sitio para todo.
    if (!isActive && !broken) return drawn
    const shown = broken ? '–' : `${list.length}`

    // Primer clic: la lista. Segundo clic mientras se ve: lo limpia todo.
    const show = async () => {
      const now = await $.clock.now()
      if (isActive && now - shownAt < DOBLE) {
        shownAt = 0
        await clearAll($)
        $.ui.toast('Avisos limpiados', { timeoutMs: 3000 })
        return
      }
      shownAt = now
      // Una sola línea, como en working: 🟡 te pide una decisión, 🔵 ha terminado.
      const lines = list.map(chat => `${chat.needsAction ? '🟡' : '🔵'} ${corto(chat.title)}`)
      $.ui.toast(isActive ? `${lines.join('  ')}  · otro clic para limpiar` : 'Ningún chat te espera', { timeoutMs: DOBLE })
    }

    return (
      <Box>
        <Button key="pendientes" plain dimColor={!isActive} onPress={show}>
          {ICONO}{' '}
          <Text color={isActive ? 'claude' : 'inactive'} bold={isActive}>{shown}</Text>
        </Button>
        {drawn}
      </Box>
    )
  })
}
