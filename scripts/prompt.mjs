// Hidden terminal input for the setup scripts: typed or pasted characters show as *.

// Piped input (not a terminal) is read line by line, for scripted use.
const pipedLines = []
let pipedDone = false
if (!process.stdin.isTTY) {
  let buffered = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => (buffered += chunk))
  process.stdin.on('end', () => {
    pipedLines.push(...buffered.split(/\r?\n/).filter(Boolean))
    pipedDone = true
  })
}

/** Prompts with hidden typing. Resolves null when input ends. */
export async function askHidden(question) {
  process.stdout.write(question)
  if (!process.stdin.isTTY) {
    while (!pipedDone) await new Promise((r) => setTimeout(r, 20))
    const line = pipedLines.shift()
    process.stdout.write(line ? '********\n' : '\n')
    return line ?? null
  }
  return new Promise((resolve) => {
    const stdin = process.stdin
    let value = ''
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          process.stdout.write('\n')
          return resolve(value.trim())
        }
        if (ch === '\x03') {
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\x7f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        value += ch
        process.stdout.write('*')
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  })
}
