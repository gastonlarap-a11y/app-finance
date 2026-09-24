package mailsync

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	_ "github.com/emersion/go-message/charset" // decodes ISO-8859-1 & co. (banks still send them)
	"github.com/emersion/go-message/mail"
	"golang.org/x/net/html"
)

// Message is a fetched email reduced to what parsers need: its identity, who
// sent it and its readable text (the text/plain part, or the text/html part
// converted to text when there is no plain one).
type Message struct {
	MessageID string
	From      string // address only, lowercased
	Subject   string
	Date      time.Time
	Text      string
}

// parseMessage decodes a raw RFC 5322 message (MIME, transfer encodings and
// charsets included).
func parseMessage(raw []byte) (Message, error) {
	r, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return Message{}, fmt.Errorf("reading message: %w", err)
	}
	defer r.Close()

	var msg Message
	msg.MessageID, _ = r.Header.MessageID() // optional header: a missing one is just empty
	msg.Subject, _ = r.Header.Subject()     // undecodable subject: parsers fall back to the body
	msg.Date, _ = r.Header.Date()           // missing date: the zero time
	if from, err := r.Header.AddressList("From"); err == nil && len(from) > 0 {
		msg.From = strings.ToLower(from[0].Address)
	}

	var plain, htmlText string
	for {
		part, err := r.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Message{}, fmt.Errorf("reading message part: %w", err)
		}
		h, ok := part.Header.(*mail.InlineHeader)
		if !ok {
			continue // attachment
		}
		ct, _, err := h.ContentType()
		if err != nil {
			continue // unparseable content type: not a text part we can use
		}
		body, err := io.ReadAll(part.Body)
		if err != nil {
			return Message{}, fmt.Errorf("reading %s part: %w", ct, err)
		}
		switch ct {
		case "text/plain":
			if plain == "" {
				plain = string(body)
			}
		case "text/html":
			if htmlText == "" {
				htmlText = htmlToText(string(body))
			}
		}
	}
	msg.Text = plain
	if strings.TrimSpace(msg.Text) == "" {
		msg.Text = htmlText
	}
	msg.Text = collapseSpaces(msg.Text)
	return msg, nil
}

// blockTags end a line of text when rendered.
var blockTags = map[string]bool{
	"br": true, "p": true, "div": true, "tr": true, "li": true, "table": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "td": true,
}

// htmlToText keeps the visible text of an HTML body, one line per block
// element and cell, skipping scripts and styles.
func htmlToText(src string) string {
	z := html.NewTokenizer(strings.NewReader(src))
	var sb strings.Builder
	skip := 0 // depth inside <script>/<style>
	for {
		switch z.Next() {
		case html.ErrorToken:
			return sb.String() // io.EOF or malformed tail: keep what was read
		case html.StartTagToken, html.SelfClosingTagToken:
			name, _ := z.TagName()
			tag := string(name)
			if tag == "script" || tag == "style" {
				skip++
			}
			if blockTags[tag] {
				sb.WriteByte('\n')
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			tag := string(name)
			if (tag == "script" || tag == "style") && skip > 0 {
				skip--
			}
			if blockTags[tag] {
				sb.WriteByte('\n')
			}
		case html.TextToken:
			if skip == 0 {
				sb.Write(z.Text()) // already entity-decoded by the tokenizer
				sb.WriteByte(' ')
			}
		}
	}
}

// collapseSpaces trims every line, collapses runs of blanks (incl. &nbsp;)
// and drops empty lines, so parsers can match "Monto: $16.182" reliably.
func collapseSpaces(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, " ", " "), "\n")
	out := lines[:0]
	for _, line := range lines {
		if f := strings.Fields(line); len(f) > 0 {
			out = append(out, strings.Join(f, " "))
		}
	}
	return strings.Join(out, "\n")
}
