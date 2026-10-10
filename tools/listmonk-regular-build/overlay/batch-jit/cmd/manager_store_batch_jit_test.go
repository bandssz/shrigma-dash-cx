package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
)

type batchJITRecorder struct {
	queries []string
	contexts []context.Context
	err error
}

func (r *batchJITRecorder) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	r.queries = append(r.queries, query)
	r.contexts = append(r.contexts, ctx)
	if len(args) != 0 { return nil, errors.New("unexpected parameters") }
	return nil, r.err
}

func TestBatchJITOneTransactionLocalStatement(t *testing.T) {
	ctx := context.WithValue(context.Background(), struct{}{}, "batch fixture")
	r := &batchJITRecorder{}
	if err := setBatchLocalJITOff(ctx, r); err != nil { t.Fatal(err) }
	if len(r.queries) != 1 || r.queries[0] != "SET LOCAL jit='off'" || r.contexts[0] != ctx {
		t.Fatalf("incorrect transaction-local call: %v", r.queries)
	}
}

func TestBatchJITFailureIsRedactedAndNotRetried(t *testing.T) {
	r := &batchJITRecorder{err: errors.New("private fixture detail")}
	err := setBatchLocalJITOff(context.Background(), r)
	if err == nil || strings.Contains(err.Error(), "private fixture detail") || len(r.queries) != 1 {
		t.Fatal("failure must stop without leaking or retrying")
	}
}

func TestBatchJITCancelledTransactionStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background()); cancel()
	r := &batchJITRecorder{err: context.Canceled}
	if err := setBatchLocalJITOff(ctx, r); err == nil || len(r.queries) != 1 || r.contexts[0].Err() != context.Canceled {
		t.Fatal("cancellation must remain a failure")
	}
}
