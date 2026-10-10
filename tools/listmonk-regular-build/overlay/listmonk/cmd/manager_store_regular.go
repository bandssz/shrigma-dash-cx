package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/knadh/listmonk/internal/manager"
	"github.com/knadh/listmonk/models"
	"github.com/lib/pq"
)

const regularDeliveryTimeout = 12 * time.Second

func regularDeliveryTx() (context.Context, context.CancelFunc, *sql.TxOptions) {
	ctx, cancel := context.WithTimeout(context.Background(), regularDeliveryTimeout)
	return ctx, cancel, &sql.TxOptions{Isolation: sql.LevelReadCommitted}
}

func setRegularDeliveryBoundary(ctx context.Context, tx interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}) error {
	if _, err := tx.ExecContext(ctx, "SET LOCAL statement_timeout='10s'"); err != nil {
		return errors.New("regular delivery transaction boundary unavailable")
	}
	if _, err := tx.ExecContext(ctx, "SET LOCAL lock_timeout='500ms'"); err != nil {
		return errors.New("regular delivery transaction boundary unavailable")
	}
	return nil
}

func (s *store) RegularDeliveryGate(campaignID int) (manager.RegularDeliveryGate, error) {
	ctx, cancel, options := regularDeliveryTx()
	defer cancel()
	tx, err := db.BeginTxx(ctx, options)
	if err != nil {
		return manager.RegularDeliveryGate{}, errors.New("regular delivery gate unavailable")
	}
	defer tx.Rollback()
	if err := setRegularDeliveryBoundary(ctx, tx); err != nil {
		return manager.RegularDeliveryGate{}, err
	}
	var row struct {
		Bound            bool   `db:"bound"`
		Ready            bool   `db:"ready"`
		ConfigurationSet string `db:"configuration_set"`
	}
	err = tx.GetContext(ctx, &row, `
WITH binding AS (
 SELECT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_effective($1)) AS bound
), control AS (
 SELECT enabled,suspended,configuration_set FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=$1
)
SELECT binding.bound,
 CASE WHEN NOT binding.bound THEN true ELSE
  EXISTS(SELECT 1 FROM control c WHERE c.enabled AND NOT c.suspended)
  AND NOT EXISTS(SELECT 1 FROM public.shrigma_email_dispatch d
   WHERE d.flow='campaign' AND d.piece='audience-regular-v1:'||$1::text
    AND d.transport_state IN('in_flight','outcome_unknown')
    AND NOT crm_audience_v2.regular_delivery_permanently_excluded(d.dispatch_id,$1::integer))
 END AS ready,
 CASE WHEN binding.bound THEN coalesce((SELECT configuration_set FROM control),'') ELSE '' END AS configuration_set
FROM binding`, campaignID)
	if err != nil {
		return manager.RegularDeliveryGate{}, errors.New("regular delivery gate unavailable")
	}
	if err := tx.Commit(); err != nil {
		return manager.RegularDeliveryGate{}, errors.New("regular delivery gate commit unconfirmed")
	}
	if row.Bound && row.Ready && row.ConfigurationSet == "" {
		return manager.RegularDeliveryGate{}, errors.New("regular delivery gate unavailable")
	}
	return manager.RegularDeliveryGate{Bound: row.Bound, Ready: row.Ready, ConfigurationSet: row.ConfigurationSet}, nil
}

func (s *store) HeartbeatRegularWorker(request manager.RegularWorkerHeartbeat) (manager.RegularWorkerHeartbeatResult, error) {
	started := time.Now()
	ctx, cancel, options := regularDeliveryTx()
	defer cancel()
	tx, err := db.BeginTxx(ctx, options)
	if err != nil {
		return manager.RegularWorkerHeartbeatResult{}, errors.New("regular worker heartbeat unavailable")
	}
	defer tx.Rollback()
	if err := setRegularDeliveryBoundary(ctx, tx); err != nil {
		return manager.RegularWorkerHeartbeatResult{}, err
	}
	var raw []byte
	if err := tx.GetContext(ctx, &raw, `SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3)`,
		request.InstanceID, request.WorkerSHA256, request.RuntimeSHA256); err != nil {
		return manager.RegularWorkerHeartbeatResult{}, errors.New("regular worker heartbeat unavailable")
	}
	var response struct {
		Ready      bool       `json:"ready"`
		Reason     string     `json:"reason"`
		InstanceID *string    `json:"instance_id"`
		CheckedAt  *time.Time `json:"checked_at"`
		ExpiresAt  *time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || response.Reason == "" {
		return manager.RegularWorkerHeartbeatResult{}, errors.New("regular worker heartbeat response invalid")
	}
	out := manager.RegularWorkerHeartbeatResult{Ready: response.Ready, Reason: response.Reason}
	if response.Ready {
		if response.Reason != "ready" || response.InstanceID == nil || *response.InstanceID != request.InstanceID ||
			response.CheckedAt == nil || response.ExpiresAt == nil {
			return out, errors.New("regular worker heartbeat response invalid")
		}
		deadline, valid := regularDeliveryGrantDeadline(started, *response.CheckedAt, *response.ExpiresAt)
		if !valid {
			return out, errors.New("regular worker heartbeat response invalid")
		}
		out.InstanceID = *response.InstanceID
		out.CheckedAt = *response.CheckedAt
		out.ExpiresAt = *response.ExpiresAt
		out.Deadline = deadline
	} else if response.InstanceID != nil || response.CheckedAt != nil || response.ExpiresAt != nil {
		return out, errors.New("regular worker heartbeat response invalid")
	}
	// A ready:false response can carry a durable suspension. It is effective
	// only after this COMMIT is confirmed, just like a successful renewal.
	if err := tx.Commit(); err != nil {
		return out, errors.New("regular worker heartbeat commit unconfirmed")
	}
	if out.Ready && !time.Now().Before(out.Deadline) {
		return out, errors.New("regular worker heartbeat expired before use")
	}
	return out, nil
}

func (s *store) ClaimRegularDelivery(request manager.RegularDeliveryClaim) (manager.RegularDeliveryClaimResult, error) {
	started := time.Now()
	ctx, cancel, options := regularDeliveryTx()
	defer cancel()
	tx, err := db.BeginTxx(ctx, options)
	if err != nil {
		return manager.RegularDeliveryClaimResult{}, errors.New("regular delivery claim unavailable")
	}
	defer tx.Rollback()
	if err := setRegularDeliveryBoundary(ctx, tx); err != nil {
		return manager.RegularDeliveryClaimResult{}, err
	}
	var raw []byte
	err = tx.GetContext(ctx, &raw, `SELECT crm_audience_v2.regular_delivery_claim_live(
 $1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
		request.InstanceID, request.CampaignID, request.SubscriberID, request.DispatchID,
		request.WorkerSHA256, request.RuntimeSHA256, request.EnvelopeFrom,
		request.EnvelopeTo, request.PayloadSHA256, string(request.SubscriberSnapshot), request.ConfigurationSet)
	if err != nil {
		return manager.RegularDeliveryClaimResult{}, errors.New("regular delivery claim unavailable")
	}
	var result struct {
		ShouldSend bool      `json:"should_send"`
		Reason     string    `json:"reason"`
		DispatchID *string   `json:"dispatch_id"`
		ClaimToken *string   `json:"claim_token"`
		CheckedAt  time.Time `json:"checked_at"`
		ValidUntil time.Time `json:"valid_until"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return manager.RegularDeliveryClaimResult{}, errors.New("regular delivery claim response invalid")
	}
	out := manager.RegularDeliveryClaimResult{ShouldSend: result.ShouldSend, Reason: result.Reason,
		CheckedAt: result.CheckedAt, ValidUntil: result.ValidUntil}
	if result.DispatchID != nil {
		out.DispatchID = *result.DispatchID
	}
	if result.ClaimToken != nil {
		out.ClaimToken = *result.ClaimToken
	}
	if result.ShouldSend {
		deadline, valid := regularDeliveryGrantDeadline(started, result.CheckedAt, result.ValidUntil)
		if !valid || out.DispatchID != request.DispatchID || out.ClaimToken == "" {
			return out, errors.New("regular delivery claim response invalid")
		}
		if err := tx.Commit(); err != nil {
			return out, errors.New("regular delivery claim commit unconfirmed")
		}
		if !time.Now().Before(deadline) {
			return out, errors.New("regular delivery claim expired before transport")
		}
		return out, nil
	}
	if err := tx.Commit(); err != nil {
		return out, errors.New("regular delivery claim commit unconfirmed")
	}
	return out, nil
}

func regularDeliveryGrantDeadline(started, checkedAt, validUntil time.Time) (time.Time, bool) {
	window := validUntil.Sub(checkedAt)
	if window <= 0 {
		return time.Time{}, false
	}
	return started.Add(window), true
}

func (s *store) FinishRegularDelivery(campaignID, subscriberID int, dispatchID, claimToken, outcome string) error {
	ctx, cancel, options := regularDeliveryTx()
	defer cancel()
	tx, err := db.BeginTxx(ctx, options)
	if err != nil {
		return errors.New("regular delivery finish unavailable")
	}
	defer tx.Rollback()
	if err := setRegularDeliveryBoundary(ctx, tx); err != nil {
		return err
	}
	var raw []byte
	if err := tx.GetContext(ctx, &raw, `SELECT crm_audience_v2.regular_delivery_finish(
 $1,$2,$3::uuid,$4::uuid,$5)`, campaignID, subscriberID, dispatchID, claimToken, outcome); err != nil {
		return errors.New("regular delivery finish unavailable")
	}
	var result struct {
		DispatchID string `json:"dispatch_id"`
		Outcome    string `json:"outcome"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || result.DispatchID != dispatchID || result.Outcome != outcome {
		return errors.New("regular delivery finish response invalid")
	}
	if err := tx.Commit(); err != nil {
		return errors.New("regular delivery finish commit unconfirmed")
	}
	return nil
}

func (s *store) FinalizeRegularDelivery(campaignID int) error {
	ctx, cancel, options := regularDeliveryTx()
	defer cancel()
	tx, err := db.BeginTxx(ctx, options)
	if err != nil {
		return errors.New("regular delivery finalization unavailable")
	}
	defer tx.Rollback()
	if err := setRegularDeliveryBoundary(ctx, tx); err != nil {
		return err
	}
	var control struct {
		Status    string `db:"status"`
		Enabled   bool   `db:"enabled"`
		Suspended bool   `db:"suspended"`
	}
	if err := tx.GetContext(ctx, &control, `SELECT c.status::text,r.enabled,r.suspended
 FROM public.campaigns c
 JOIN LATERAL crm_audience_v2.campaign_binding_effective(c.id) b ON true
 JOIN crm_audience_v2.regular_delivery_campaign r ON r.campaign_id=c.id
 WHERE c.id=$1 FOR UPDATE OF c,r`, campaignID); err != nil {
		return errors.New("regular delivery finalization unavailable")
	}
	if control.Status != models.CampaignStatusRunning || !control.Enabled || control.Suspended {
		return errors.New("regular delivery finalization denied")
	}
	var unresolved bool
	if err := tx.GetContext(ctx, &unresolved, `SELECT EXISTS(SELECT 1 FROM public.shrigma_email_dispatch d
 WHERE d.flow='campaign' AND d.piece='audience-regular-v1:'||$1::text
  AND d.transport_state IN('in_flight','outcome_unknown')
  AND NOT crm_audience_v2.regular_delivery_permanently_excluded(d.dispatch_id,$1::integer))`, campaignID); err != nil || unresolved {
		return errors.New("regular delivery finalization requires reconciliation")
	}
	var camps []runningCamp
	if err := tx.Stmtx(s.queries.GetRunningCampaign).SelectContext(ctx, &camps, campaignID); err != nil || len(camps) == 0 {
		return errors.New("regular delivery finalization context unavailable")
	}
	listIDs := make([]int, 0, len(camps))
	for _, campaign := range camps {
		listIDs = append(listIDs, campaign.ListID)
	}
	var remaining []models.Subscriber
	if err := tx.Stmtx(s.queries.NextCampaignSubscribers).SelectContext(ctx, &remaining,
		camps[0].CampaignID, camps[0].CampaignType, camps[0].LastSubscriberID,
		camps[0].MaxSubscriberID, pq.Array(listIDs), 1); err != nil {
		return errors.New("regular delivery finalization selector unavailable")
	}
	if len(remaining) != 0 {
		return errors.New("regular delivery finalization found pending recipient")
	}
	result, err := tx.ExecContext(ctx, `UPDATE public.campaigns SET status='finished',updated_at=clock_timestamp()
 WHERE id=$1 AND status='running'`, campaignID)
	if err != nil {
		return errors.New("regular delivery finalization unavailable")
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return errors.New("regular delivery finalization changed concurrently")
	}
	if err := tx.Commit(); err != nil {
		return errors.New("regular delivery finalization commit unconfirmed")
	}
	return nil
}

// campaignScanPhase and the classifier intentionally expose only closed static values.
// Returned errors contain no original error and cannot unwrap to private driver fields.
type campaignScanPhase uint8

const (
	campaignScanBegin campaignScanPhase = iota
	campaignScanBoundary
	campaignScanQuarantine
	campaignScanSelect
	campaignScanCommit
)

func campaignScanError(phase campaignScanPhase, err error) error {
	name := "OTHER"
	switch phase {
	case campaignScanBegin:
		name = "begin"
	case campaignScanBoundary:
		name = "boundary"
	case campaignScanQuarantine:
		name = "quarantine"
	case campaignScanSelect:
		name = "select"
	case campaignScanCommit:
		name = "commit"
	}
	class := "OTHER"
	if errors.Is(err, context.Canceled) {
		class = "CANCELED"
	} else if errors.Is(err, context.DeadlineExceeded) {
		class = "DEADLINE"
	} else {
		var pgErr *pq.Error
		if errors.As(err, &pgErr) && pgErr != nil {
			switch pgErr.Code {
			case "57014":
				class = "57014"
			case "55P03":
				class = "55P03"
			case "40P01":
				class = "40P01"
			case "53300":
				class = "53300"
			case "08006":
				class = "08006"
			case "42501":
				class = "42501"
			case "42P01":
				class = "42P01"
			case "42883":
				class = "42883"
			case "25P02":
				class = "25P02"
			}
		}
	}
	return errors.New("campaign scan unavailable phase=" + name + " class=" + class)
}

// Scanner-only boundary keeps the same statements, order, and transaction.
// Other regular-delivery methods retain their existing redacted errors unchanged.
func setCampaignScanBoundary(ctx context.Context, tx interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}) error {
	if _, err := tx.ExecContext(ctx, "SET LOCAL statement_timeout='10s'"); err != nil {
		return campaignScanError(campaignScanBoundary, err)
	}
	if _, err := tx.ExecContext(ctx, "SET LOCAL lock_timeout='500ms'"); err != nil {
		return campaignScanError(campaignScanBoundary, err)
	}
	return nil
}
