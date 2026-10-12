import { describe, expect, it } from 'vitest'

import { isRecoverySnapshotInfo, shouldOfferRecovery } from './recovery'

describe('shouldOfferRecovery', () => {
  it('offers the snapshot when it is newer than the project file', () => {
    expect(shouldOfferRecovery(2000, 1000)).toBe(true)
  })

  it('skips the snapshot when the file is newer or equally old', () => {
    expect(shouldOfferRecovery(1000, 2000)).toBe(false)
    expect(shouldOfferRecovery(1000, 1000)).toBe(false)
  })
})

describe('isRecoverySnapshotInfo', () => {
  const info = { path: '/tmp/project.oanim', name: 'project', savedAt: 1728700000000 }

  it('accepts a round-tripped snapshot info', () => {
    expect(isRecoverySnapshotInfo(JSON.parse(JSON.stringify(info)))).toBe(true)
  })

  it('rejects wrong shapes and types', () => {
    expect(isRecoverySnapshotInfo(null)).toBe(false)
    expect(isRecoverySnapshotInfo([])).toBe(false)
    expect(isRecoverySnapshotInfo({})).toBe(false)
    expect(isRecoverySnapshotInfo({ ...info, path: 7 })).toBe(false)
    expect(isRecoverySnapshotInfo({ ...info, name: null })).toBe(false)
    expect(isRecoverySnapshotInfo({ ...info, savedAt: 'now' })).toBe(false)
  })
})
