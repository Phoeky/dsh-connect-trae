import { describe, expect, it } from 'vitest'
import { traeEditionsInCommands } from '../src/trae-process.ts'

// These run against a synthetic `ps` dump: the real probe shells out, and what
// matters here is only how the listing is read. The names are prefixes of one
// another (`Trae` vs `Trae CN`), so a naive substring test would report the
// international app running whenever only the Chinese one was, and the delete
// would then refuse for the wrong edition.
const ps = (...dirs: string[]): string => dirs
  .map(dir => `/Applications/Trae.app/Contents/MacOS/Trae --user-data-dir=/Users/x/Library/Application Support/${dir}`)
  .join('\n')

describe('reading the running Trae apps out of a process listing', () => {
  it('reports the Chinese app alone when only its directory is open', () => {
    expect([...traeEditionsInCommands(ps('Trae CN'), 'Application Support')]).toEqual(['cn'])
  })

  it('does not mistake the Chinese app for the international one', () => {
    // The bug this guards: `includes('Trae')` is true of `Trae CN`, which would
    // block a delete with "quit Trae" while the user is looking at Trae CN.
    const running = traeEditionsInCommands(ps('Trae CN'), 'Application Support')
    expect(running.has('sg')).toBe(false)
  })

  it('reports both when both directories are open, without double counting', () => {
    const running = traeEditionsInCommands(ps('Trae', 'Trae CN', 'TRAE SOLO CN', 'TRAE SOLO'), 'Application Support')
    expect([...running].sort()).toEqual(['cn', 'sg', 'solo', 'solo-sg'])
  })

  it('reports nothing when the listing has no Trae app', () => {
    expect([...traeEditionsInCommands('node server.js\nGoogle Chrome', 'Application Support')]).toEqual([])
  })
})
