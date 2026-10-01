package manager

import (
	"fmt"
	"strings"

	"github.com/knadh/listmonk/models"
)

// GraphTemplateSnapshot is the exact raw identity of a compiled transactional
// template in this Manager process. It intentionally excludes rendered bytes.
type GraphTemplateSnapshot struct {
	TemplateID int     `json:"template_id"`
	Type       string  `json:"type"`
	Subject    string  `json:"subject"`
	Body       string  `json:"body"`
	BodySource *string `json:"body_source"`
}

// GraphTemplateSnapshot reads the same in-memory map used by GetTpl(). The
// caller can therefore attest the cache that will render /api/tx, rather than
// a database row or a cache in another process.
func (m *Manager) GraphTemplateSnapshot(id int) (GraphTemplateSnapshot, error) {
	tpl, err := m.GetTpl(id)
	if err != nil {
		return GraphTemplateSnapshot{}, err
	}
	return GraphTemplateSnapshotFrom(id, tpl)
}

// GraphTemplateSnapshotFrom captures the raw identity and compiled state of a
// specific template pointer. /api/tx uses this to carry the exact instance it
// rendered across the final cache-identity check.
func GraphTemplateSnapshotFrom(id int, tpl *models.Template) (GraphTemplateSnapshot, error) {
	if tpl == nil || tpl.ID != id {
		return GraphTemplateSnapshot{}, fmt.Errorf("graph cache template %d instance mismatch", id)
	}
	if tpl.Type != "tx" || tpl.Tpl == nil {
		return GraphTemplateSnapshot{}, fmt.Errorf("graph cache template %d is not a compiled tx template", id)
	}
	var bodySource *string
	if tpl.BodySource.Valid {
		v := tpl.BodySource.String
		bodySource = &v
	}
	if strings.Contains(tpl.Subject, "{{") && tpl.SubjectTpl == nil {
		return GraphTemplateSnapshot{}, fmt.Errorf("graph cache template %d has an uncompiled subject", id)
	}
	return GraphTemplateSnapshot{
		TemplateID: id,
		Type:       tpl.Type,
		Subject:    tpl.Subject,
		Body:       tpl.Body,
		BodySource: bodySource,
	}, nil
}
