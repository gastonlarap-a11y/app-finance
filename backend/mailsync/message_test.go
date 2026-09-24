package mailsync

import (
	"strings"
	"testing"
)

func TestParseMessagePrefersPlainTextAndDecodesCharsets(t *testing.T) {
	raw := "From: =?ISO-8859-1?Q?Banco_Ita=FA?= <Alertas@Banco.Test>\r\n" +
		"Subject: =?ISO-8859-1?Q?Compra_aprobada_en_cr=E9dito?=\r\n" +
		"Date: Fri, 17 Jul 2026 13:45:00 -0400\r\n" +
		"Message-ID: <abc@banco.test>\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=\"b\"\r\n\r\n" +
		"--b\r\n" +
		"Content-Type: text/plain; charset=ISO-8859-1\r\n" +
		"Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
		"Monto:   $16.182\r\nComercio: CRUZ VERDE =\r\nL9093\r\n\r\n" +
		"--b\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n\r\n" +
		"<p>ignored because a plain part exists</p>\r\n" +
		"--b--\r\n"
	msg, err := parseMessage([]byte(raw))
	if err != nil {
		t.Fatalf("parseMessage: %v", err)
	}
	if msg.From != "alertas@banco.test" || msg.MessageID != "abc@banco.test" || msg.Subject != "Compra aprobada en crédito" {
		t.Fatalf("headers = %+v", msg)
	}
	if msg.Date.Day() != 17 {
		t.Fatalf("date = %v", msg.Date)
	}
	if msg.Text != "Monto: $16.182\nComercio: CRUZ VERDE L9093" {
		t.Fatalf("text = %q", msg.Text)
	}
}

func TestParseMessageFallsBackToHTML(t *testing.T) {
	raw := "From: alertas@banco.test\r\nSubject: x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" +
		"<html><head><style>p{color:red}</style><script>var x=1</script></head><body>" +
		"<table><tr><td>Monto</td><td>$&nbsp;5.990</td></tr><tr><td>Comercio</td><td>ENTEL &amp; CO</td></tr></table>" +
		"</body></html>"
	msg, err := parseMessage([]byte(raw))
	if err != nil {
		t.Fatalf("parseMessage: %v", err)
	}
	for _, want := range []string{"Monto\n$ 5.990", "Comercio\nENTEL & CO"} {
		if !strings.Contains(msg.Text, want) {
			t.Errorf("text %q lacks %q", msg.Text, want)
		}
	}
	if strings.Contains(msg.Text, "color") || strings.Contains(msg.Text, "var x") {
		t.Errorf("text %q kept style/script content", msg.Text)
	}
}
