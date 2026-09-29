// Package migrations keeps the schema history of the removed mail sync
// (IMAP bank alerts): the applied migration that created mail_accounts and the
// one that drops it. Applied migrations are never deleted, so this set stays
// registered in the migrator. Desktop only: the web engine never loaded it.
package migrations

import "embed"

//go:embed *.sql
var Migrations embed.FS
