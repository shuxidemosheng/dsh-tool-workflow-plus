import { describe, expect, it } from 'vitest'
import { savedWorkflowSchema, workflowSavedDomain } from '../src/domain.js'

const validRecord = {
  meta: { name: 'audit', description: 'Audit files' },
  script: 'return 1',
  createdAt: 1_000,
  updatedAt: 2_000,
}

describe('savedWorkflowSchema', () => {
  it('accepts a valid record', () => {
    expect(savedWorkflowSchema.safeParse(validRecord).success).toBe(true)
  })

  it('accepts a record with optional meta annotations', () => {
    expect(savedWorkflowSchema.safeParse({
      ...validRecord,
      meta: {
        name: 'audit',
        description: 'Audit files',
        whenToUse: 'always',
        phases: [{ title: 'scan', detail: 'scan files' }],
      },
    }).success).toBe(true)
  })

  it('rejects unknown top-level fields', () => {
    expect(savedWorkflowSchema.safeParse({ ...validRecord, extra: 1 }).success).toBe(false)
  })

  it('rejects unknown meta fields', () => {
    expect(savedWorkflowSchema.safeParse({
      ...validRecord,
      meta: { name: 'a', description: 'b', extra: 1 },
    }).success).toBe(false)
  })

  it('rejects an empty script', () => {
    expect(savedWorkflowSchema.safeParse({ ...validRecord, script: '' }).success).toBe(false)
  })

  it('rejects non-integer or negative timestamps', () => {
    expect(savedWorkflowSchema.safeParse({ ...validRecord, createdAt: 1.5 }).success).toBe(false)
    expect(savedWorkflowSchema.safeParse({ ...validRecord, updatedAt: -1 }).success).toBe(false)
  })

  it('rejects a phase without a title', () => {
    expect(savedWorkflowSchema.safeParse({
      ...validRecord,
      meta: { name: 'a', description: 'b', phases: [{ detail: 'no title' }] },
    }).success).toBe(false)
  })
})

describe('workflowSavedDomain spec', () => {
  it('declares the workflow_saved domain with a per-record workflows table', () => {
    expect(workflowSavedDomain.name).toBe('workflow_saved')
    expect(workflowSavedDomain.layout).toBe('per-record')
    expect(Object.keys(workflowSavedDomain.tables)).toEqual(['workflows'])
    expect(workflowSavedDomain.version).toBe(1)
  })
})
