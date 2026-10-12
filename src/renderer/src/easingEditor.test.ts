// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { EASING_PRESETS } from '@shared/easing'
import type { Easing } from '@shared/easing'

import { EasingEditor } from './easingEditor'

/**
 * Widget-level tests for the cubic-bezier easing editor. happy-dom has no 2d
 * context, so these cover the select + numeric-field half of the widget (the
 * canvas plot is skipped at construction); the plot's pointer math is only
 * reachable in a real browser.
 */
describe('EasingEditor', () => {
  let changes: Easing[]
  let widget: EasingEditor

  beforeEach(() => {
    document.body.textContent = ''
    changes = []
    widget = new EasingEditor({ onChange: (easing) => changes.push(easing) })
    document.body.appendChild(widget.root)
  })

  const field = (name: 'x1' | 'y1' | 'x2' | 'y2'): HTMLInputElement =>
    widget.root.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)!
  const preset = (): HTMLSelectElement =>
    widget.root.querySelector<HTMLSelectElement>('select')!
  const setField = (name: 'x1' | 'y1' | 'x2' | 'y2', value: string): void => {
    const input = field(name)
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const pickPreset = (id: string): void => {
    preset().value = id
    preset().dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('skips the canvas plot when no 2d context is available', () => {
    expect(widget.root.querySelector('canvas')).toBeNull()
    expect(widget.root.querySelectorAll('input')).toHaveLength(4)
    expect(preset()).not.toBeNull()
  })

  it('offers every preset plus a Custom option', () => {
    const values = [...preset().options].map((option) => option.value)
    expect(values).toEqual([...EASING_PRESETS.map((entry) => entry.id), 'custom'])
  })

  it('syncs the fields and the select from a named easing without emitting', () => {
    widget.setValue('ease-in-out')
    expect(changes).toEqual([])
    expect(preset().value).toBe('ease-in-out')
    expect([field('x1').value, field('y1').value, field('x2').value, field('y2').value]).toEqual([
      '0.42',
      '0',
      '0.58',
      '1'
    ])
  })

  it('shows Custom for a bezier that matches no preset', () => {
    widget.setValue({ x1: 0.2, y1: 0.4, x2: 0.6, y2: 0.8 })
    expect(preset().value).toBe('custom')
    expect(field('y1').value).toBe('0.4')
  })

  it('picks named presets by name and unnamed presets by bezier', () => {
    pickPreset('ease-out')
    expect(changes).toEqual(['ease-out'])

    pickPreset('ease-in-back')
    expect(changes[1]).toEqual({ x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 })
    // The fields mirror the picked bezier for further tweaking.
    expect(field('x2').value).toBe('0.66')
  })

  it('emits clamped bezier objects from the numeric fields', () => {
    widget.setValue('linear')
    setField('x1', '5')
    expect(changes[0]).toEqual({ x1: 1, y1: 0, x2: 1, y2: 1 })
    expect(field('x1').value).toBe('1')

    setField('y1', '-9')
    expect(changes[1]).toEqual({ x1: 1, y1: -2, x2: 1, y2: 1 })

    setField('y2', '9')
    expect(changes[2]).toEqual({ x1: 1, y1: -2, x2: 1, y2: 3 })
    expect(field('y2').value).toBe('3')
  })

  it('falls back to the current value for an emptied field', () => {
    widget.setValue({ x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 })
    setField('x1', '')
    expect(changes).toEqual([{ x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 }])
    expect(field('x1').value).toBe('0.3')
  })

  it('always emits bezier objects from the fields, even when they match a preset', () => {
    setField('x1', '0.42')
    setField('y1', '0')
    setField('x2', '0.58')
    setField('y2', '1')
    // The select shows the matching preset, but the emitted values stay beziers.
    expect(preset().value).toBe('ease-in-out')
    expect(changes.every((value) => typeof value === 'object')).toBe(true)
    expect(changes[3]).toEqual({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 })
  })

  it('keeps the value when Custom is re-picked', () => {
    widget.setValue({ x1: 0.2, y1: 0.4, x2: 0.6, y2: 0.8 })
    pickPreset('custom')
    expect(changes).toEqual([])
    expect(preset().value).toBe('custom')
  })

  it('disables the preset picker and every field together', () => {
    widget.setDisabled(true)
    expect(preset().disabled).toBe(true)
    expect(widget.root.querySelectorAll('input:disabled')).toHaveLength(4)
    expect(widget.root.classList.contains('disabled')).toBe(true)
    widget.setDisabled(false)
    expect(preset().disabled).toBe(false)
    expect(widget.root.querySelectorAll('input:disabled')).toHaveLength(0)
  })
})
