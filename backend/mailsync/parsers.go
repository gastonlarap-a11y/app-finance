package mailsync

import "github.com/gastonlarap-a11y/app-finance/backend/finance"

// EmailParser reads one issuer's alert emails (Strategy): Matches recognizes
// its emails by sender and subject, Parse extracts the movements. A parser
// returning an error for a matched email reports a format it no longer
// understands — the email is counted as unreadable, never guessed.
type EmailParser interface {
	Issuer() string
	Matches(msg Message) bool
	Parse(msg Message) ([]finance.ImportCandidate, error)
}

// DefaultParsers is the registry of supported alert formats. Each parser is
// written and tested against real (anonymized) samples of its emails; until a
// bank's parser exists, its emails are fetched but reported as unrecognized.
func DefaultParsers() []EmailParser {
	return []EmailParser{}
}

// parserFor returns the first parser that recognizes the message.
func parserFor(parsers []EmailParser, msg Message) EmailParser {
	for _, p := range parsers {
		if p.Matches(msg) {
			return p
		}
	}
	return nil
}
