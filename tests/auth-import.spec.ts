import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TraeCredentialStore } from '../src/auth.ts'

const temp = () => mkdtemp(join(tmpdir(), 'trae-store-'))

describe('import + refresh coexistence (issue #37 plan B)', () => {
  it('importing a second account does not delete the first', async () => {
    const dir = await temp(); const own = join(dir, 'own.json')
    const store = new TraeCredentialStore({ storagePath: join(dir,'none.json'), edition: 'cn', ownPath: own, refresh: async () => { throw new Error('unused') } })
    const base = { refreshToken: 'rt', host: 'https://api.trae.cn', userRegion: 'CN', expiresAtMs: Date.now()+86_400_000, edition: 'cn' as const }
    await store.importAccounts([{ ...base, accessToken: 'tokA', userId: 'userA', accountName: 'A' }])
    await store.importAccounts([{ ...base, accessToken: 'tokB', userId: 'userB', accountName: 'B' }])
    const doc = JSON.parse(await readFile(own,'utf8'))
    expect(doc.version).toBe(2)
    expect(doc.credentials).toHaveLength(2)
    const ids = (await store.accounts()).map(a=>a.accountName).sort()
    expect(ids).toEqual(['A','B'])
  })

  it('a refresh after an import does not erase the imported account', async () => {
    const dir = await temp(); const own = join(dir, 'own.json')
    const base = { refreshToken: 'rt', host: 'https://api.trae.cn', userRegion: 'CN', expiresAtMs: Date.now()+3_600_000, edition: 'cn' as const }
    const store = new TraeCredentialStore({ storagePath: join(dir,'none.json'), edition: 'cn', ownPath: own, refresh: async () => { throw new Error('unused') } })
    // Imported account is bound LAST by importAccounts, but give the DESKTOP
    // account the selection so `resolve()` exercises the refresh path against
    // the own file that already holds an imported entry.
    await store.importAccounts([{ ...base, accessToken: 'imported', userId: 'userImp', accountName: 'Imported' }])
    // A desktop credential that will need refreshing, plus the imported one.
    await writeFile(join(dir,'storage.json'), JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token:'old', refreshToken:'desk-rt', userId:'userDesk', account:'Desk', host:'https://api.trae.cn', userRegion:'CN', expiredAt: Date.now()-1000, refreshExpiredAt: Date.now()+86_400_000 }) }))
    const store2 = new TraeCredentialStore({ storagePath: join(dir,'storage.json'), edition: 'cn', ownPath: own, refresh: async () => ({ accessToken:'refreshed', refreshToken:'rt2', expiresAtMs: Date.now()+3_600_000 }) })
    // Bind the DESKTOP account explicitly so the refresh targets it rather than
    // the (still valid) imported one.
    const all = await store2.accounts()
    const deskId = all.find(account => account.source === 'desktop')!.id
    store2.selectAccount(deskId)
    await store2.resolve()
    const doc = JSON.parse(await readFile(own,'utf8'))
    expect(doc.credentials.map((entry: { userId: string }) => entry.userId).sort()).toEqual(['userDesk', 'userImp'])
  })

  it('reads a legacy version-1 file and upgrades it on write', async () => {
    const dir = await temp(); const own = join(dir, 'own.json')
    await writeFile(own, JSON.stringify({ version: 1, credential: { accessToken:'v1tok', refreshToken:'rt', userId:'legacy', host:'https://api.trae.cn', userRegion:'CN', expiresAtMs: Date.now()+86_400_000, edition:'cn', source:'dsh' } }))
    const store = new TraeCredentialStore({ storagePath: join(dir,'none.json'), edition: 'cn', ownPath: own, refresh: async () => { throw new Error('unused') } })
    const creds = await store.accounts()
    expect(creds).toHaveLength(1)
    await store.importAccounts([{ accessToken:'new', refreshToken:'rt', userId:'another', host:'https://api.trae.cn', userRegion:'CN', expiresAtMs: Date.now()+86_400_000, edition:'cn' }])
    const doc = JSON.parse(await readFile(own,'utf8'))
    expect(doc.version).toBe(2)
    expect(doc.credentials.map((entry: { userId: string }) => entry.userId).sort()).toEqual(['another', 'legacy'])
  })
})
