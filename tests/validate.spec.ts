import { describe, expect, it } from 'vitest'
import { asWorkflowMeta, metaViolations, scriptViolations, violationsMessage } from '../src/validate.js'

describe('metaViolations（与引擎 META_INVALID 同口径）', () => {
  it('accepts a minimal valid meta', () => {
    expect(metaViolations({ name: 'audit', description: 'Audit files' })).toEqual([])
  })

  it('accepts a full valid meta with phases', () => {
    expect(metaViolations({
      name: 'audit',
      description: 'Audit files',
      whenToUse: 'when many files need auditing',
      phases: [{ title: 'scan' }, { title: 'verify', detail: 'adversarial check', provider: 'p', model: 'm' }],
    })).toEqual([])
  })

  it('rejects non-object meta', () => {
    expect(metaViolations(null)).toEqual(['meta must be an object'])
    expect(metaViolations([1])).toEqual(['meta must be an object'])
    expect(metaViolations('x')).toEqual(['meta must be an object'])
  })

  it('rejects unknown fields by name', () => {
    const violations = metaViolations({ name: 'a', description: 'b', extra: 1 })
    expect(violations).toEqual(['meta.extra is not a recognized field (name/description/whenToUse/phases)'])
  })

  it('requires non-empty name and description', () => {
    expect(metaViolations({ description: 'd' })).toContain('meta.name must be a non-empty string')
    expect(metaViolations({ name: 'n' })).toContain('meta.description must be a non-empty string')
    expect(metaViolations({ name: '', description: '' })).toEqual([
      'meta.name must be a non-empty string',
      'meta.description must be a non-empty string',
    ])
  })

  it('rejects a non-string whenToUse', () => {
    expect(metaViolations({ name: 'n', description: 'd', whenToUse: 3 as never })).toContain('meta.whenToUse must be a string')
  })

  it('validates each phase entry field by field', () => {
    const violations = metaViolations({
      name: 'n',
      description: 'd',
      phases: [
        { title: 'ok' },
        { nope: 1 },
        { title: '' },
        { title: 'p', detail: 2 as never },
      ],
    })
    expect(violations).toContain('meta.phases[1].nope is not a recognized field')
    expect(violations).toContain('meta.phases[1].title must be a non-empty string')
    expect(violations).toContain('meta.phases[2].title must be a non-empty string')
    expect(violations).toContain('meta.phases[3].detail must be a string')
    expect(violations).not.toContain('meta.phases[0].title must be a non-empty string')
  })

  it('rejects a non-array phases', () => {
    expect(metaViolations({ name: 'n', description: 'd', phases: 'scan' as never })).toContain('meta.phases must be an array')
  })
})

describe('scriptViolations', () => {
  it('accepts a clean script body', () => {
    expect(scriptViolations('const x = await agent("hi")\nreturn x')).toEqual([])
  })

  it('rejects an empty or whitespace-only script', () => {
    expect(scriptViolations('')).toContain('script must be a non-empty JavaScript body')
    expect(scriptViolations('   \n\t ')).toContain('script must be a non-empty JavaScript body')
  })

  it('rejects an export const meta block in any spacing', () => {
    expect(scriptViolations('export const meta = { name: "x" }\nreturn 1')).toHaveLength(1)
    expect(scriptViolations('export  const   meta={name:"x"}\nreturn 1')).toHaveLength(1)
    expect(scriptViolations('return 1 // export const meta is not allowed')).toHaveLength(1)
  })
})

describe('violationsMessage / asWorkflowMeta', () => {
  it('joins violations into one readable message', () => {
    const message = violationsMessage(['meta.name must be a non-empty string', 'script must be a non-empty JavaScript body'])
    expect(message).toMatch(/2 violation\(s\)/)
    expect(message).toContain('- meta.name must be a non-empty string')
  })

  it('asWorkflowMeta narrows to the engine shape, conditionally including optionals', () => {
    expect(asWorkflowMeta({ name: 'n', description: 'd' })).toEqual({ name: 'n', description: 'd' })
    expect(asWorkflowMeta({
      name: 'n',
      description: 'd',
      whenToUse: 'w',
      phases: [{ title: 'p' }],
    })).toEqual({ name: 'n', description: 'd', whenToUse: 'w', phases: [{ title: 'p' }] })
  })
})
