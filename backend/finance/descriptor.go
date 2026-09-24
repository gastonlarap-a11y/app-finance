package finance

import (
	"strings"
	"unicode/utf8"
)

// suggestedPatternWords is how many leading significant words of a descriptor
// a learned rule keys on by default ("cruz verde", "entel pcs").
const suggestedPatternWords = 2

// normalizeDescriptor reduces a bank descriptor to its stable words: lowercase,
// without tokens carrying digits (store or terminal ids such as "L9093") or
// single letters (the trailing channel code), whitespace collapsed.
// "CRUZ VERDE L9093 CHILLAN  C" → "cruz verde chillan".
func normalizeDescriptor(s string) string {
	words := make([]string, 0, 8)
	for w := range strings.FieldsSeq(strings.ToLower(s)) {
		if utf8.RuneCountInString(w) < 2 || strings.ContainsAny(w, "0123456789") {
			continue
		}
		words = append(words, w)
	}
	return strings.Join(words, " ")
}

// suggestPattern proposes the rule pattern for a descriptor: its first
// significant words, so the rule also covers other branches of the merchant.
func suggestPattern(description string) string {
	words := strings.Fields(normalizeDescriptor(description))
	return strings.Join(words[:min(len(words), suggestedPatternWords)], " ")
}

// ruleFor returns the rule whose pattern prefixes the descriptor at a word
// boundary; the longest (most specific) pattern wins, ties keep the first.
func ruleFor(rules []MerchantRule, description string) (MerchantRule, bool) {
	norm := normalizeDescriptor(description)
	var best MerchantRule
	found := false
	for _, r := range rules {
		if norm != r.Pattern && !strings.HasPrefix(norm, r.Pattern+" ") {
			continue
		}
		// Counted in runes, like the TS engine's [...pattern].length.
		if !found || utf8.RuneCountInString(r.Pattern) > utf8.RuneCountInString(best.Pattern) {
			best, found = r, true
		}
	}
	return best, found
}
