package manager

import (
	"io"
	"log"
	"testing"

	"github.com/knadh/listmonk/internal/i18n"
	"github.com/knadh/listmonk/models"
	null "gopkg.in/volatiletech/null.v6"
)

type graphCacheStore struct{}

func (graphCacheStore) NextCampaigns([]int64, []int64) ([]*models.Campaign, error) { return nil, nil }
func (graphCacheStore) NextSubscribers(int, int) ([]models.Subscriber, error)      { return nil, nil }
func (graphCacheStore) GetCampaign(int) (*models.Campaign, error)                  { return nil, nil }
func (graphCacheStore) GetAttachment(int) (models.Attachment, error)               { return models.Attachment{}, nil }
func (graphCacheStore) UpdateCampaignStatus(int, string) error                     { return nil }
func (graphCacheStore) UpdateCampaignCounts(int, int, int, int) error              { return nil }
func (graphCacheStore) CreateLink(string) (string, error)                          { return "", nil }
func (graphCacheStore) BlocklistSubscriber(int64) error                            { return nil }
func (graphCacheStore) DeleteSubscriber(int64) error                               { return nil }

func graphManagerFixture(t *testing.T, body string) *Manager {
	t.Helper()
	language, err := i18n.New([]byte(`{"_.code":"en","_.name":"English"}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Config{Concurrency: 1, MessageRate: 1}, graphCacheStore{}, language, log.New(io.Discard, "", 0))
	tpl := models.Template{Base: models.Base{ID: 71}, Type: models.TemplateTypeTx, Subject: "Subject {{ .Subscriber.Email }}", Body: body, BodySource: null.NewString("source", true)}
	if err := tpl.Compile(m.GenericTemplateFuncs()); err != nil {
		t.Fatal(err)
	}
	m.CacheTpl(tpl.ID, &tpl)
	return m
}

func TestGraphTemplateSnapshotUsesTheManagerLocalCache(t *testing.T) {
	first := graphManagerFixture(t, `{{ define "content" }}first{{ end }}`)
	second := graphManagerFixture(t, `{{ define "content" }}second{{ end }}`)

	a, err := first.GraphTemplateSnapshot(71)
	if err != nil {
		t.Fatal(err)
	}
	b, err := second.GraphTemplateSnapshot(71)
	if err != nil {
		t.Fatal(err)
	}
	if a.Body == b.Body || a.TemplateID != b.TemplateID || a.Type != "tx" || b.Type != "tx" {
		t.Fatalf("two process-local caches were not distinguished: %#v %#v", a, b)
	}

	first.CacheTpl(71, &models.Template{Base: models.Base{ID: 71}, Type: models.TemplateTypeTx})
	if _, err := first.GraphTemplateSnapshot(71); err == nil {
		t.Fatal("uncompiled replacement cache was accepted")
	}
}
