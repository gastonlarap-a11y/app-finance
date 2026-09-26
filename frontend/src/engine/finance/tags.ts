// Pure tag-name rules, ported from backend/finance/tag.go.
import { ErrValidation, newError } from '@/engine/errors'

export const maxTagsPerExpense = 10
export const maxTagLen = 30

type TagError = ReturnType<typeof newError>

// tagKey is the case-insensitive identity of a tag name (Go strings.ToLower).
export function tagKey(name: string): string {
  return name.toLowerCase()
}

// cleanTagName trims a tag name and collapses its inner spaces.
export function cleanTagName(name: string): { name?: string; error?: TagError } {
  const clean = name.trim().split(/\s+/).filter(Boolean).join(' ')
  if (clean === '') return { error: newError(ErrValidation, 'la etiqueta no puede estar vacía') }
  // Rune count, as Go's utf8.RuneCountInString (not UTF-16 units).
  if ([...clean].length > maxTagLen) {
    return { error: newError(ErrValidation, `la etiqueta «${clean}» supera los ${maxTagLen} caracteres`) }
  }
  return { name: clean }
}

// normalizeTags cleans the names, drops empty ones and case-insensitive repeats
// (the first spelling wins) and caps how many an expense carries.
export function normalizeTags(names: readonly string[]): { names?: string[]; error?: TagError } {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of names) {
    if (n.trim() === '') continue
    const clean = cleanTagName(n)
    if (clean.error || clean.name === undefined) return { error: clean.error }
    if (seen.has(tagKey(clean.name))) continue
    seen.add(tagKey(clean.name))
    out.push(clean.name)
  }
  if (out.length > maxTagsPerExpense) {
    return { error: newError(ErrValidation, `un gasto puede tener hasta ${maxTagsPerExpense} etiquetas`) }
  }
  return { names: out }
}
