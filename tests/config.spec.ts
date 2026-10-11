import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('fills defaults when config is undefined', () => {
    expect(resolveConfig(undefined)).toEqual({
      toolName: 'workflow',
      maxResultChars: 50_000,
      enableRunInBackground: true,
      savedTools: true,
    })
  })

  it('accepts a full explicit config', () => {
    expect(resolveConfig({
      toolName: 'workflow_plus',
      maxResultChars: 1000,
      enableRunInBackground: false,
      savedTools: false,
    })).toEqual({
      toolName: 'workflow_plus',
      maxResultChars: 1000,
      enableRunInBackground: false,
      savedTools: false,
    })
  })

  it('trims toolName', () => {
    expect(resolveConfig({ toolName: '  workflow  ' }).toolName).toBe('workflow')
  })

  it('rejects unknown keys loudly', () => {
    expect(() => resolveConfig({ toolNmae: 'x' } as never)).toThrow(/unknown key/)
  })

  it('rejects empty toolName', () => {
    expect(() => resolveConfig({ toolName: '   ' })).toThrow(/toolName/)
  })

  it('rejects non-integer or non-positive maxResultChars', () => {
    expect(() => resolveConfig({ maxResultChars: 0 })).toThrow(/maxResultChars/)
    expect(() => resolveConfig({ maxResultChars: 1.5 })).toThrow(/maxResultChars/)
    expect(() => resolveConfig({ maxResultChars: -3 })).toThrow(/maxResultChars/)
  })

  it('rejects non-boolean flags', () => {
    expect(() => resolveConfig({ enableRunInBackground: 'yes' as never })).toThrow(/enableRunInBackground/)
    expect(() => resolveConfig({ savedTools: 1 as never })).toThrow(/savedTools/)
  })
})
