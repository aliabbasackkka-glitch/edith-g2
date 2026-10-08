// Reads the calendar file behind a private iCal link (Google, Outlook, iCloud) on the phone,
// so EDITH's server never has to parse it. Only what the next couple of weeks need: events
// with a start, repeating events, all-day events, cancellations and changed occurrences.

export interface CalendarEvent {
  /** When it starts, in the phone's own time. */
  start: Date
  end: Date | null
  title: string
  where: string
  allDay: boolean
}

interface RawEvent {
  uid: string
  start: { ms: number; allDay: boolean } | null
  end: { ms: number; allDay: boolean } | null
  title: string
  where: string
  cancelled: boolean
  rrule: string
  exdates: number[]
  recurrenceId: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** Unfolds the wrapped lines an iCal file uses and splits it into lines. */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

/** iCal escapes commas, semicolons and newlines in text values. */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

/** How far a time zone is from UTC at a moment, in minutes (IANA names, as calendars use). */
function zoneOffsetMinutes(zone: string, ms: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms))
    const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const asUtc = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'))
    return Math.round((asUtc - ms) / 60000)
  } catch {
    return 0
  }
}

/** One DTSTART/DTEND/EXDATE value, with its parameters, as a moment in time. */
function readTime(params: string, value: string): { ms: number; allDay: boolean } | null {
  const date = value.trim()
  const allDay = /VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(date)
  const m = date.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (allDay || z) return { ms: asUtc, allDay }
  const zone = (params.match(/TZID=([^;:]+)/i) || [])[1]
  if (zone) {
    // The wall-clock time is in that zone: take the offset off, twice, so a time near a
    // daylight-saving change lands on the right moment.
    const first = asUtc - zoneOffsetMinutes(zone, asUtc) * 60000
    return { ms: asUtc - zoneOffsetMinutes(zone, first) * 60000, allDay: false }
  }
  // No zone: floating time, which means the phone's own.
  const local = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return { ms: local.getTime(), allDay: false }
}

function parseEvents(lines: string[]): RawEvent[] {
  const events: RawEvent[] = []
  let current: RawEvent | null = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = { uid: '', start: null, end: null, title: '', where: '', cancelled: false, rrule: '', exdates: [], recurrenceId: null }
      continue
    }
    if (!current) continue
    if (line === 'END:VEVENT') {
      if (current.start) events.push(current)
      current = null
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const left = line.slice(0, colon)
    const value = line.slice(colon + 1)
    const name = left.split(';')[0].toUpperCase()
    const params = left.slice(name.length)
    switch (name) {
      case 'UID':
        current.uid = value.trim()
        break
      case 'SUMMARY':
        current.title = unescapeText(value)
        break
      case 'LOCATION':
        current.where = unescapeText(value)
        break
      case 'STATUS':
        current.cancelled = value.trim().toUpperCase() === 'CANCELLED'
        break
      case 'DTSTART':
        current.start = readTime(params, value)
        break
      case 'DTEND':
        current.end = readTime(params, value)
        break
      case 'RRULE':
        current.rrule = value.trim()
        break
      case 'EXDATE':
        for (const one of value.split(',')) {
          const at = readTime(params, one)
          if (at) current.exdates.push(at.ms)
        }
        break
      case 'RECURRENCE-ID':
        current.recurrenceId = readTime(params, value)?.ms ?? null
        break
    }
  }
  return events
}

const rulePart = (rule: string, key: string): string => (rule.match(new RegExp(`(?:^|;)${key}=([^;]*)`, 'i')) || [])[1] || ''

/**
 * When a repeating event happens between `from` and `until`. Covers the rules calendars
 * really use: daily, weekly (with weekdays), monthly, yearly, every n, a count, an end date.
 */
function repeats(event: RawEvent, from: number, until: number): number[] {
  const rule = event.rrule
  const start = event.start!.ms
  const freq = rulePart(rule, 'FREQ').toUpperCase()
  if (!freq) return start >= from && start <= until ? [start] : []
  const interval = Math.max(1, Number(rulePart(rule, 'INTERVAL') || 1))
  const count = Number(rulePart(rule, 'COUNT') || 0)
  const endsAt = readTime('', rulePart(rule, 'UNTIL'))?.ms ?? Infinity
  const byDay = rulePart(rule, 'BYDAY')
    .split(',')
    .map((d) => WEEKDAYS.indexOf(d.replace(/^[+-]?\d/, '').toUpperCase()))
    .filter((i) => i >= 0)

  const out: number[] = []
  const first = new Date(start)
  let made = 0
  // Walk from the event's start; two years of steps is far more than the fortnight asked for.
  for (let step = 0; step < 800 && made < (count || Infinity); step++) {
    let when: Date
    if (freq === 'DAILY') when = new Date(start + step * interval * DAY_MS)
    else if (freq === 'WEEKLY') when = new Date(start + step * interval * 7 * DAY_MS)
    else if (freq === 'MONTHLY') {
      when = new Date(first)
      when.setMonth(first.getMonth() + step * interval)
    } else if (freq === 'YEARLY') {
      when = new Date(first)
      when.setFullYear(first.getFullYear() + step * interval)
    } else break

    if (freq === 'WEEKLY' && byDay.length) {
      // Each wanted weekday in that week.
      const weekStart = when.getTime() - when.getDay() * DAY_MS
      for (const day of byDay) {
        const at = weekStart + day * DAY_MS
        if (at < start) continue
        if (at > endsAt) break
        made++
        if (at >= from && at <= until) out.push(at)
        if (count && made >= count) break
      }
      if (when.getTime() > until && out.length) break
      continue
    }
    const at = when.getTime()
    if (at > endsAt) break
    made++
    if (at >= from && at <= until) out.push(at)
    if (at > until) break
  }
  return out
}

/**
 * The events in the next `days` days, soonest first. `now` is there for tests.
 */
export function upcomingEvents(ics: string, { days = 14, now = Date.now(), limit = 60 } = {}): CalendarEvent[] {
  const events = parseEvents(unfold(ics))
  const from = now - 12 * 60 * 60 * 1000 // still show something that started earlier today
  const until = now + days * DAY_MS
  // A changed occurrence (RECURRENCE-ID) replaces that one time of the repeating event.
  const changed = new Map<string, RawEvent>()
  for (const e of events) if (e.recurrenceId !== null) changed.set(`${e.uid}|${e.recurrenceId}`, e)

  const out: CalendarEvent[] = []
  for (const event of events) {
    if (event.recurrenceId !== null) continue
    const length = event.end && event.start ? Math.max(0, event.end.ms - event.start.ms) : 0
    for (const at of repeats(event, from, until)) {
      if (event.exdates.includes(at)) continue
      const instead = changed.get(`${event.uid}|${at}`)
      const use = instead ?? event
      if (use.cancelled) continue
      const startMs = instead?.start?.ms ?? at
      const allDay = Boolean(use.start?.allDay)
      out.push({
        start: new Date(allDay ? startMs + new Date(startMs).getTimezoneOffset() * 60000 : startMs),
        end: length || instead?.end ? new Date((instead?.end?.ms ?? startMs + length)) : null,
        title: use.title || '(no title)',
        where: use.where,
        allDay,
      })
    }
  }
  // A cancelled occurrence of a repeating event also comes as its own entry.
  for (const e of changed.values()) {
    if (!e.cancelled || !e.start) continue
    const at = e.start.ms
    const i = out.findIndex((o) => o.start.getTime() === at && o.title === e.title)
    if (i >= 0) out.splice(i, 1)
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, limit)
}
