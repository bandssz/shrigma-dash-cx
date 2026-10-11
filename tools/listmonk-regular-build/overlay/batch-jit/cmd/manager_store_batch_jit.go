package main

import (
	"context"
	"database/sql"
	"errors"
)

// Linked only by the exact explicit SOURCE batch profile. It never changes session/global JIT.
func setBatchLocalJITOff(ctx context.Context, tx interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}) error {
	if _, err := tx.ExecContext(ctx, "SET LOCAL jit='off'"); err != nil {
		return errors.New("batch local JIT boundary unavailable")
	}
	return nil
}
