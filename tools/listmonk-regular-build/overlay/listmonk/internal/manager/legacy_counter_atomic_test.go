package manager

import (
	"errors"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/knadh/listmonk/models"
	"github.com/paulbellamy/ratecounter"
)

// This fixture invokes the actual compiled Manager/pipe methods. It models only
// the two SQL sent+=delta calls, with no database, worker loop, SMTP or network.
// Embedded interfaces panic if an unexpected production method is reached.
type legacyCounterStore struct {
	Store
	RegularDeliveryStore
	total atomic.Int64
	flushCalls atomic.Int64
	entered chan int
	release chan struct{}
}

func (s *legacyCounterStore) UpdateCampaignCounts(_ int, toSend, sent, lastID int) error {
	if toSend != 0 {
		panic("counter fixture must not change to_send")
	}
	s.flushCalls.Add(1)
	if s.entered != nil {
		s.entered <- sent
		<-s.release
	}
	s.total.Add(int64(sent))
	return nil
}

func (s *legacyCounterStore) NextCampaigns(ids, counts []int64) ([]*models.Campaign, error) {
	if len(ids) != len(counts) {
		panic("counter fixture array mismatch")
	}
	for _, n := range counts {
		s.total.Add(n)
	}
	return nil, nil
}

func (s *legacyCounterStore) RegularDeliveryGate(_ int) (RegularDeliveryGate, error) {
	return RegularDeliveryGate{Bound: false}, nil
}

func legacyCounterPipe(s *legacyCounterStore) (*Manager, *pipe) {
	c := new(models.Campaign)
	c.ID = 175
	c.Messenger = "counter-fixture"
	m := &Manager{
		store: s,
		cfg: Config{MessageRate: 100},
		log: log.New(io.Discard, "", 0),
		pipes: make(map[int]*pipe),
	}
	p := &pipe{m: m, camp: c, wg: new(sync.WaitGroup), rate: ratecounter.NewRateCounter(time.Minute)}
	m.pipes[c.ID] = p
	return m, p
}

func legacyCounterWait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("counter fixture did not close")
	}
}

// BEFORE: cleanup.Load(95) blocks in the store; scanner.Load/Store emits 95;
// both add95 => 17835. AFTER: cleanup.Swap takes95; scanner.Swap emits0 =>17740.
// No timing sleep or nondeterministic race is needed to select this schedule.
func TestLegacyCounterCleanupScannerOverlap(t *testing.T) {
	s := &legacyCounterStore{entered: make(chan int, 1), release: make(chan struct{})}
	s.total.Store(17645)
	m, p := legacyCounterPipe(s)
	p.sent.Store(95)
	p.stopped.Store(true) // cleanup stops after count flush; no notification path.
	done := make(chan struct{})
	go func() { p.cleanup(); close(done) }()
	var cleanupDelta int
	select {
	case cleanupDelta = <-s.entered:
	case <-time.After(2 * time.Second):
		close(s.release)
		t.Fatal("cleanup never reached its real counter flush")
	}
	ids, counts := m.getCurrentCampaigns()
	_, err := s.NextCampaigns(ids, counts)
	close(s.release)
	legacyCounterWait(t, done)
	if err != nil { t.Fatal(err) }
	if cleanupDelta != 95 || len(counts) != 1 || counts[0] != 0 || s.total.Load() != 17740 {
		t.Fatalf("legacy counter double-accounted: cleanup=%d scanner=%v total=%d; want95/0/17740", cleanupDelta, counts, s.total.Load())
	}
	if p.sent.Load() != 0 || len(m.pipes) != 0 || s.flushCalls.Load() != 1 {
		t.Fatal("cleanup failed to drain/remove exactly once")
	}
}

func TestLegacyCounterScannerThenCleanup(t *testing.T) {
	s := &legacyCounterStore{}
	m, p := legacyCounterPipe(s)
	p.sent.Store(95)
	p.stopped.Store(true)
	ids, counts := m.getCurrentCampaigns()
	if _, err := s.NextCampaigns(ids, counts); err != nil { t.Fatal(err) }
	p.cleanup()
	if len(counts) != 1 || counts[0] != 95 || s.total.Load() != 95 || p.sent.Load() != 0 {
		t.Fatalf("unexpected disjoint drains: counts=%v total=%d", counts, s.total.Load())
	}
}

func TestLegacyCounterRepeatedScanDoesNotReplay(t *testing.T) {
	s := &legacyCounterStore{}
	m, p := legacyCounterPipe(s)
	p.sent.Store(95)
	for i := 0; i < 2; i++ {
		ids, counts := m.getCurrentCampaigns()
		if _, err := s.NextCampaigns(ids, counts); err != nil { t.Fatal(err) }
	}
	if s.total.Load() != 95 { t.Fatalf("replayed total=%d", s.total.Load()) }
}

func TestLegacyCounterBoundCleanupNeverUsesLegacyFlush(t *testing.T) {
	s := &legacyCounterStore{}
	m, p := legacyCounterPipe(s)
	p.sent.Store(95) // sentinel: bound counter path must not drain legacy state.
	p.bound.Store(true)
	p.cleanup()
	if s.flushCalls.Load() != 0 || s.total.Load() != 0 || p.sent.Load() != 95 || len(m.pipes) != 0 {
		t.Fatal("protected cleanup reached the legacy counter or changed its sentinel")
	}
}

type legacyCounterMessenger struct {
	err error
	calls int
}
func (m *legacyCounterMessenger) Name() string { return "counter-fixture" }
func (m *legacyCounterMessenger) Push(_ models.Message) error { m.calls++; return m.err }
func (m *legacyCounterMessenger) Flush() error { return nil }
func (m *legacyCounterMessenger) Close() error { return nil }

func TestLegacyCounterQueuedCompletion(t *testing.T) {
	for _, fail := range []bool{false, true} {
		name := "success"
		if fail { name = "transport-error" }
		t.Run(name, func(t *testing.T) {
			s := &legacyCounterStore{}
			m, p := legacyCounterPipe(s)
			msgr := &legacyCounterMessenger{}
			if fail { msgr.err = errors.New("synthetic refusal") }
			m.messengers = map[string]Messenger{"counter-fixture": msgr}
			sub := models.Subscriber{}
			sub.ID = 19
			p.wg.Add(1)
			m.processQueuedCampaignMessage(CampaignMessage{Campaign: p.camp, Subscriber: sub, pipe: p}, new(int))
			done := make(chan struct{})
			go func() { p.wg.Wait(); close(done) }()
			legacyCounterWait(t, done)
			want := int64(1)
			if fail { want = 0 }
			if p.sent.Load() != want || msgr.calls != 1 {
				t.Fatalf("transport completion count=%d calls=%d", p.sent.Load(), msgr.calls)
			}
		})
	}
}
