/** 改用统一存储命名空间后，验证已有账号、设置及备份仍能读取。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export async function verifyChannelStorageCompatibility() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-storage-compat-'))
  const directory = path.join(home, 'channel-pack')
  fs.mkdirSync(directory)
  const savedOverride = process.env.DSH_CHANNEL_PACK_STATE_DIR
  process.env.DSH_CHANNEL_PACK_STATE_DIR = home
  const disposals = []
  const ctx = { profileContext: { home }, get(name) { return this[name] }, logger: { warn() {} },
    effect(install) { const dispose = install(); if (typeof dispose === 'function') disposals.push(dispose) } }
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value))
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
  try {
    const { createBadgePreferenceStore } = await import('../vendor/channel-pack/src/badge-preferences.ts')
    const { createPermanentLockStore } = await import('../vendor/channel-pack/src/permanent-lock-store.ts')
    const { createAutoCheckinStore } = await import('../vendor/channel-pack/src/auto-checkin.ts')
    const { createTokenLedgerStore } = await import('../vendor/channel-pack/src/token-ledger-store.ts')
    write('ui-preferences.json', { schema: 'legacy-channel-pack/ui-preferences/v1', badgePreference: 'credits' })
    const preference = createBadgePreferenceStore(ctx)
    assert.equal(preference.load(), 'credits')
    await preference.save(preference.load())
    assert.equal(read('ui-preferences.json').schema, 'channel-pack/ui-preferences/v1')
    write('permanent-locks.json', { schema: 'legacy-channel-pack/permanent-locks/v1', locks: { loomy: true } })
    const locks = createPermanentLockStore(ctx)
    assert.deepEqual(locks.load(), { exists: true, locks: { loomy: true } })
    await locks.save(locks.load().locks)
    assert.equal(read('permanent-locks.json').schema, 'channel-pack/permanent-locks/v1')
    write('auto-checkin.json', { schema: 'legacy-channel-pack/auto-checkin/v1', enabled: false, lastDate: '2026-01-01' })
    const checkin = createAutoCheckinStore(ctx)
    assert.equal(checkin.load().enabled, false)
    assert.equal(checkin.load().lastDate, '2026-01-01')
    await checkin.save(checkin.load())
    assert.equal(read('auto-checkin.json').schema, 'channel-pack/auto-checkin/v1')
    const day = new Date().toISOString().slice(0, 10)
    write('token-ledger.json', { schema: 'legacy-channel-pack/token-ledger/v1', days: {
      [day]: { fixture: { requests: 2, inputTokens: 17, outputTokens: 9 } },
    } })
    const ledger = createTokenLedgerStore(ctx)
    assert.equal(ledger.load().get(day).get('fixture').inputTokens, 17)
    ledger.append({ ts: Date.now(), channel: 'gateway', provider: 'lobsterai', model: 'fixture',
      accountId: 'fixture', usageReported: true, inputTokens: 1, outputTokens: 1, durationMs: 1 })
    ledger.flush()
    assert.equal(read('token-ledger.json').schema, 'channel-pack/token-ledger/v1')
    const { importBackup, exportBackup } = await import('../vendor/channel-pack/src/backup.ts')
    const account = { id: 'fixture', provider: 'lobsterai', nickname: 'fixture', enabled: true,
      refreshable: false, credentialRef: 'LOBSTERAI_ACCOUNT_FIXTURE', createdAt: 1 }
    const token = '{"access_token":"fixture","custom_field":"preserved"}'
    const payload = { format: 'legacy-channel-pack/backup', version: 1, exportedAt: new Date().toISOString(),
      accounts: [account], credentials: { [account.credentialRef]: token }, disabledModels: { loomy: { fixture: true } },
      permanentLocks: { loomy: true } }
    let imported, writes = 0
    const credentials = { async set(ref, value) { writes++; assert.equal(value, token) }, async resolve() { return { value: token } } }
    const pool = { async replaceAll(...value) { imported = value },
      getStateSnapshot: () => ({ accounts: [account], disabledModels: payload.disabledModels }),
      permanentLocksSnapshot: () => payload.permanentLocks }
    await importBackup(credentials, pool, payload)
    assert.equal(writes, 1)
    assert.deepEqual(imported, [payload.accounts, payload.disabledModels, payload.permanentLocks])
    assert.equal((await exportBackup(pool, credentials)).payload.format, 'channel-pack/backup')
    await assert.rejects(importBackup(credentials, pool, { ...payload, format: 'foreign-data' }))
    await assert.rejects(importBackup(credentials, pool, { ...payload, version: 999 }))
    assert.equal(writes, 1, '无效格式或版本不得写入凭据')
    console.log('ok storage compatibility: legacy preferences, locks, check-in, ledger and backups survive namespace migration')
  } finally {
    if (savedOverride === undefined) delete process.env.DSH_CHANNEL_PACK_STATE_DIR
    else process.env.DSH_CHANNEL_PACK_STATE_DIR = savedOverride
    for (const dispose of disposals.reverse()) dispose()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
